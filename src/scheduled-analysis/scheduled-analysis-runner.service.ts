import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import { AnalysisService } from '../analysis/analysis.service';
import {
  ANALYSIS_STALE_THRESHOLD_MS,
  isAnalysisStale,
} from '../analysis/analysis-stale.util';
import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
import { EmailService } from '../email/email.service';
import { FieldsService } from '../fields/fields.service';
import { UsersService } from '../users/users.service';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import {
  ScheduledAnalysisRun,
  ScheduledRunTriggerSource,
} from './entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from './entities/weekly-analysis-snapshot.entity';
import { computeScheduledAnalysisDateRange } from './scheduled-analysis-date-range.util';
import {
  computeNextRunAt,
  resolveScheduledForDate,
} from './schedule-time.util';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';
import { WeeklyTechnicalVerdictService } from '../weekly-technical-verdict/weekly-technical-verdict.service';

const ERROR_MESSAGE_MAX_LENGTH = 500;

// PR 12A: ventana de gracia para esperar a que AnalysisVerdictService termine de generar (o de
// fallar) el veredicto técnico antes de mandar el mail sin esa sección. generateAndPersist corre
// best-effort DESPUÉS de que Analysis pasa a 'Finalizado' (ver
// AnalysisService.processFieldAnalysisInBackground) — no hay ningún hook que avise cuándo
// termina, así que reconcile (@Interval cada 2 min) puede encontrar el run 'completed' antes de
// que exista la fila en analysis_technical_verdicts. Pasados 10 minutos sin veredicto, se manda
// el mail igual: mejor un reporte semanal sin esa sección que uno que nunca sale.
const VERDICT_WAIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Motor de ejecución de Fase 4A. Reutiliza el pipeline manual TAL CUAL — nunca duplica lógica de
 * análisis: solo llama a AnalysisService.runFieldAnalysis (el mismo método detrás de
 * POST /analysis/field/:fieldId) con los flags del "informe visual completo", y a
 * AnalysisService.findOne para observar cuándo ese Analysis (fire-and-forget, igual que en el
 * flujo manual) termina. No modifica analysis.service.ts.
 *
 * FIX (recuperación de snapshot faltante): antes, la creación del WeeklyAnalysisSnapshot vivía
 * únicamente dentro de la rama `run.status === 'processing'` de reconcileRun — el único momento en
 * que se tenía el Analysis 'Finalizado' a mano. Si WeeklyAnalysisSnapshotService.createFromAnalysis
 * fallaba transitoriamente ahí (DB caída un instante, etc.), el run ya había sido persistido como
 * 'completed' un par de líneas antes, así que el próximo tick de reconciliación nunca volvía a
 * entrar a esa rama (el run ya no está 'processing') y quedaba huérfano para siempre: sin
 * snapshot, sin diagnóstico semanal, sin email (sendCompletionEmail encuentra el snapshot nulo y
 * se resigna en silencio cada tick). Ahora ensureSnapshot/resolveFinalizedAnalysis reintentan esa
 * dependencia en cualquier tick donde el run ya esté 'completed' sin snapshot — releyendo el
 * Analysis persistido vía AnalysisService.findOne, nunca disparando AnalysisService.runFieldAnalysis
 * de nuevo — y son idempotentes si el snapshot ya existe.
 *
 * FIX (recuperación bajo schedule deshabilitado): la corrección anterior seguía teniendo un borde
 * sin cubrir — si el schedule estaba deshabilitado (o, defensivamente, si no se lo encontraba) Y
 * ensureSnapshot fallaba en ese mismo tick, reconcileRun marcaba la corrida 'failed' de todos
 * modos, sacándola para siempre de reconcilePendingRuns y dejando el snapshot histórico huérfano
 * — el mismo bug original, esta vez encubierto por la desactivación en vez de por la falla
 * transitoria sola. Ahora esa transición a 'failed' se pospone hasta que ensureSnapshot devuelva
 * un snapshot resuelto (recién creado o ya existente): mientras no lo haga, la corrida permanece
 * 'completed' y se reintenta en cada tick — sin abrir NUNCA una ventana de envío de email mientras
 * el schedule siga deshabilitado.
 */
@Injectable()
export class ScheduledAnalysisRunnerService {
  private readonly logger = new Logger(ScheduledAnalysisRunnerService.name);

  constructor(
    @InjectRepository(FieldAnalysisSchedule)
    private readonly scheduleRepository: Repository<FieldAnalysisSchedule>,
    @InjectRepository(ScheduledAnalysisRun)
    private readonly runRepository: Repository<ScheduledAnalysisRun>,
    private readonly fieldsService: FieldsService,
    private readonly analysisService: AnalysisService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly weeklySnapshotService: WeeklyAnalysisSnapshotService,
    private readonly analysisVerdictService: AnalysisVerdictService,
    private readonly weeklyTechnicalVerdictService: WeeklyTechnicalVerdictService,
  ) {}

  // --- Dispatcher: busca schedules vencidos y los dispara ------------------------------------

  /**
   * Un campo roto (field borrado, sin lotes incluidos, worker caído) no debe frenar el resto —
   * cada schedule se procesa en su propio try/catch (ver triggerRun).
   */
  async processDueSchedules(now: Date = new Date()): Promise<void> {
    const dueSchedules = await this.scheduleRepository.find({
      where: { enabled: true, nextRunAt: LessThanOrEqual(now) },
    });

    for (const schedule of dueSchedules) {
      try {
        await this.triggerRun(schedule, now, 'automatic_dispatcher');
      } catch (error) {
        this.logger.error(
          `[scheduled-analysis] Fallo procesando schedule ${schedule.id} (fieldId=${schedule.fieldId}): ${this.describe(error)}`,
        );
      }
    }
  }

  /**
   * Dispara (o reutiliza) la corrida de la semana de `now` para `schedule`, y siempre recalcula
   * nextRunAt al final — así el dispatcher nunca vuelve a seleccionar el mismo schedule en el
   * próximo tick, sin importar si esta llamada creó una corrida nueva o reencontró una existente.
   *
   * `triggerSource` (MEASUREMENT GAP P1-01) identifica el entry point que llama — SIN default: los
   * dos únicos callers reales (processDueSchedules, runNow) lo pasan siempre explícito, así que
   * ningún caller nuevo puede crear una fila sin clasificación por omisión silenciosa. Se persiste
   * SOLO en la rama que efectivamente inserta una fila nueva más abajo — `existingRun` (acá) y el
   * loser de la carrera de unique (ver saveNewRun) devuelven la fila tal cual ya existe, sin tocar
   * su triggerSource: ese valor describe quién la CREÓ, no quién la reutilizó después.
   */
  async triggerRun(
    schedule: FieldAnalysisSchedule,
    now: Date,
    triggerSource: ScheduledRunTriggerSource,
  ): Promise<ScheduledAnalysisRun> {
    const scheduledFor = resolveScheduledForDate(now, schedule);

    const existingRun = await this.runRepository.findOne({
      where: { scheduleId: schedule.id, scheduledFor },
    });

    if (existingRun) {
      await this.advanceNextRunAt(schedule, now);
      return existingRun;
    }

    // Fase 4D: ventana móvil — reemplaza field.startDate/endDate estáticos (nunca avanzaban, ver
    // auditoría predeploy) para TODO trigger de scheduled-analysis, automático o "Ejecutar
    // ahora". El flujo manual (field-detail.component.ts → POST /analysis/field/:fieldId) no se
    // toca: sigue mandando las fechas que el usuario elige en su propio modal.
    const dateRange = computeScheduledAnalysisDateRange(now, {
      timezone: schedule.timezone,
    });
    this.logger.log(
      `[scheduled-analysis] fieldId=${schedule.fieldId} ventana móvil ${dateRange.startDate} → ${dateRange.endDate} (${dateRange.source}).`,
    );

    const created = await this.saveNewRun(
      this.runRepository.create({
        scheduleId: schedule.id,
        fieldId: schedule.fieldId,
        userId: schedule.userId,
        status: 'pending',
        scheduledFor,
        metadata: { dateRange },
        triggerSource,
      }),
      schedule.id,
      scheduledFor,
    );

    if (!created.isNew) {
      // FIX (auditoría predeploy): perdimos la carrera de unique(scheduleId, scheduledFor)
      // contra otro trigger concurrente para la misma semana (ej. el dispatcher y un "Ejecutar
      // ahora" cayendo al mismo tiempo) — esa corrida ya existe, tratamos esto igual que el
      // `existingRun` de arriba en vez de propagar el error de constraint como un 500.
      await this.advanceNextRunAt(schedule, now);
      return created.run;
    }

    let run = created.run;

    try {
      const field = await this.fieldsService.findOne(
        schedule.fieldId,
        schedule.userId,
      );

      // FIX CRÍTICO (auditoría predeploy): AnalysisService.runFieldAnalysis puede devolver
      // silenciosamente un Analysis 'Procesando' preexistente (ej. disparado manualmente segundos
      // antes) en vez de crear uno nuevo — el valor de retorno no distingue ambos casos, así que
      // el scheduler no puede confiar en él a ciegas. Chequeo defensivo ANTES de llamarlo: si ya
      // hay un análisis en curso para este campo, no lo llamamos — mejor una corrida fallida y
      // reintentable la próxima semana que un email atado al análisis de otro (con flags que no
      // son necesariamente las del informe completo). Reusa AnalysisService.findByField, ya
      // público y ya usado por el historial de diagnósticos — no toca AnalysisService.
      const history = await this.analysisService.findByField(
        schedule.fieldId,
        schedule.userId,
      );

      const blockingAnalysis = history.find(
        (item) => item.status === 'Procesando',
      );

      // OPS-1: un Analysis 'Procesando' stale (isAnalysisStale — misma utilidad que usa
      // AnalysisService.runFieldAnalysis para su propio dedupe, una sola definición de
      // "staleness" para ambos) no debe bloquear la corrida para siempre. Este chequeo NUNCA
      // marca nada como Error por su cuenta — solo decide si bloquear o no; la mutación real la
      // hace exclusivamente AnalysisService.runFieldAnalysis (llamado más abajo), que vuelve a
      // evaluar el mismo Analysis con el dato completo (startedAt) antes de tocarlo.
      if (
        blockingAnalysis &&
        !isAnalysisStale(blockingAnalysis, now, ANALYSIS_STALE_THRESHOLD_MS)
      ) {
        throw new Error(
          'Ya hay un análisis en proceso para este campo. Se reintentará en la próxima ejecución.',
        );
      }

      // Fase 4D (decisión de producto): el análisis semanal por email SIEMPRE es el informe más
      // completo — se ignoran a propósito los includeMapAssets/includeIndexImages/
      // includeImageSeries que pueda tener guardados el schedule (esas columnas quedan en la
      // entidad y en el DTO por compatibilidad futura, pero la ejecución real los fuerza a
      // `true` acá, no confía en lo que diga la DB). maxCloudiness sigue viniendo del Field —
      // solo el rango de fechas pasó a la ventana móvil.
      const analysis = await this.analysisService.runFieldAnalysis(
        schedule.fieldId,
        {
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          maxCloudiness: field.maxCloudiness,
          includeMapAssets: true,
          includeIndexImages: true,
          includeImageSeries: true,
        },
        schedule.userId,
      );

      run.analysisId = analysis.id;
      run.status = 'processing';
      run.startedAt = new Date();
      run = await this.runRepository.save(run);

      await this.scheduleRepository.update(schedule.id, {
        lastAnalysisId: analysis.id,
        lastRunAt: now,
        lastStatus: 'processing',
        lastErrorMessage: null,
      });
    } catch (error) {
      const message = this.summarizeError(error);
      run.status = 'failed';
      run.failedAt = new Date();
      run.errorMessage = message;
      run = await this.runRepository.save(run);

      await this.scheduleRepository.update(schedule.id, {
        lastRunAt: now,
        lastStatus: 'failed',
        lastErrorMessage: message,
      });
    }

    await this.advanceNextRunAt(schedule, now);
    return run;
  }

  private async advanceNextRunAt(
    schedule: FieldAnalysisSchedule,
    from: Date,
  ): Promise<void> {
    const nextRunAt = computeNextRunAt(from, schedule);
    await this.scheduleRepository.update(schedule.id, { nextRunAt });
  }

  /**
   * FIX (auditoría predeploy): inserta la corrida nueva, y si choca contra
   * unique(scheduleId, scheduledFor) — otro trigger concurrente ganó la carrera — vuelve a
   * buscarla y la devuelve en vez de dejar propagar el QueryFailedError como un 500.
   */
  private async saveNewRun(
    run: ScheduledAnalysisRun,
    scheduleId: string,
    scheduledFor: string,
  ): Promise<{ run: ScheduledAnalysisRun; isNew: boolean }> {
    try {
      const saved = await this.runRepository.save(run);
      return { run: saved, isNew: true };
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const existing = await this.runRepository.findOne({
        where: { scheduleId, scheduledFor },
      });

      if (!existing) {
        throw error;
      }

      return { run: existing, isNew: false };
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === '23505',
    );
  }

  // --- Reconciliación: detecta cuándo el Analysis (fire-and-forget) terminó ------------------

  /**
   * AnalysisService.runFieldAnalysis es fire-and-forget (igual que el flujo manual) — no hay
   * ningún hook de "análisis completado" en analysis.service.ts, así que esto es la
   * reconciliación por polling que arma el puente: para cada run 'processing', mira el Analysis
   * real (AnalysisService.findOne, sin ownership porque corre como proceso interno) y reacciona
   * cuando pasa a Finalizado/Error. También reintenta el envío de email para runs 'completed' que
   * por algún motivo se quedaron sin emailSentAt (ej. SMTP caído momentáneamente).
   */
  async reconcilePendingRuns(): Promise<void> {
    const runs = await this.runRepository.find({
      where: [{ status: 'processing' }, { status: 'completed' }],
    });

    for (const run of runs) {
      try {
        await this.reconcileRun(run);
      } catch (error) {
        this.logger.error(
          `[scheduled-analysis] Fallo reconciliando run ${run.id}: ${this.describe(error)}`,
        );
      }
    }
  }

  private async reconcileRun(run: ScheduledAnalysisRun): Promise<void> {
    // Analysis ya resuelto a 'Finalizado' EN ESTE MISMO tick (rama 'processing' de abajo) — se
    // pasa tal cual a ensureSnapshot para no volver a leerlo. Si queda undefined (el run YA
    // estaba 'completed' al empezar este tick, típicamente porque createFromAnalysis falló en un
    // tick anterior — ver FIX de snapshot faltante más abajo), ensureSnapshot lo vuelve a
    // resolver el mismo desde analysisId.
    let finalizedAnalysis: Analysis | undefined;

    if (run.status === 'processing') {
      if (!run.analysisId) {
        return;
      }

      const analysis = await this.analysisService.findOne(run.analysisId);

      if (analysis.status === 'Finalizado') {
        run.status = 'completed';
        run.completedAt = new Date();
        await this.runRepository.save(run);

        await this.scheduleRepository.update(run.scheduleId, {
          lastStatus: 'completed',
          lastErrorMessage: null,
        });

        finalizedAnalysis = analysis;
      } else if (analysis.status === 'Error') {
        run.status = 'failed';
        run.failedAt = new Date();
        run.errorMessage = analysis.errorMessage || 'El análisis falló.';
        await this.runRepository.save(run);

        await this.scheduleRepository.update(run.scheduleId, {
          lastStatus: 'failed',
          lastErrorMessage: run.errorMessage,
        });
        // Nunca se manda email si el análisis falló — MVP: sin email de error a usuario final.
        return;
      } else {
        return; // Sigue 'Procesando'.
      }
    }

    if (run.status === 'completed' && !run.emailSentAt) {
      // FIX (recuperación de snapshot faltante — ver docstring de la clase): un run 'completed'
      // puede llegar acá sin snapshot todavía, sea porque recién pasó a 'completed' arriba en
      // este mismo tick, o porque quedó así de un tick anterior en el que createFromAnalysis
      // falló transitoriamente — antes, esa segunda situación nunca se reintentaba (el bloque de
      // creación vivía solo dentro de la rama 'processing' de arriba, que un run ya 'completed'
      // nunca vuelve a atravesar). ensureSnapshot reintenta usando el Analysis YA persistido
      // (analysisService.findOne, nunca AnalysisService.runFieldAnalysis) y es idempotente si el
      // snapshot ya existe. Se hace ANTES de mirar si el schedule sigue activo, mismo criterio
      // que la creación original: es un registro histórico del Analysis, no depende de si el
      // usuario desactivó el seguimiento futuro. Se guarda el resultado porque el bloque de abajo
      // lo necesita para decidir si ya es seguro dar por perdida esta corrida (ver FIX siguiente).
      const snapshot = await this.ensureSnapshot(run, finalizedAnalysis);

      // FIX (auditoría predeploy): si el usuario desactivó el seguimiento semanal mientras esta
      // corrida seguía 'processing', el análisis igual puede terminar bien — pero ya no
      // corresponde mandar el email. Releemos el schedule (no confiamos en un valor cacheado).
      const schedule = await this.scheduleRepository.findOne({
        where: { id: run.scheduleId },
      });

      if (!schedule || !schedule.enabled) {
        if (!snapshot) {
          // FIX (recuperación bajo schedule deshabilitado): el snapshot histórico todavía no se
          // pudo recuperar en este tick (createFromAnalysis sigue fallando, o el Analysis
          // persistido sigue sin ser compatible — ver resolveFinalizedAnalysis). Marcar esta
          // corrida 'failed' ACÁ, como hacía antes esta rama, repetiría el bug original: 'failed'
          // sale para siempre de reconcilePendingRuns (solo mira processing/completed), así que el
          // registro histórico quedaría huérfano igual que antes — esta vez encubierto por el
          // schedule desactivado en vez de por la falla transitoria sola. La corrida queda
          // 'completed' sin emailSentAt: el próximo tick vuelve a intentar ensureSnapshot Y a leer
          // el schedule de nuevo (si sigue desactivado, la política de no mandar email se
          // mantiene idéntica — no se abre ninguna ventana nueva de envío).
          return;
        }

        // El snapshot histórico ya está resuelto (recién creado en este tick, o ya existía de
        // antes) — no queda ninguna dependencia pendiente para esta corrida, así que recién ACÁ es
        // seguro sacarla de reconciliación futura marcándola 'failed' con un motivo claro.
        // schedule.lastStatus no se toca: el análisis en sí terminó bien.
        //
        // `!schedule` (a diferencia de `!schedule.enabled`) es defensivo, no un caso real
        // esperado: ScheduledAnalysisRun.scheduleId es FK NOT NULL con
        // onDelete: CASCADE hacia FieldAnalysisSchedule (ver la entidad y la migración
        // 1787403339340-CreateScheduledAnalysis), y "desactivar" un schedule es siempre un UPDATE
        // enabled=false (FieldAnalysisScheduleService, upsert sobre la única fila del campo),
        // nunca un delete — un run ya persistido no debería poder sobrevivir a un schedule borrado.
        // Se conserva el mismo tratamiento que `!schedule.enabled` por si esa garantía se rompe
        // alguna vez (ej. una intervención manual en la base), en vez de dejar el run atascado.
        run.status = 'failed';
        run.errorMessage =
          'Envío de email omitido: el seguimiento semanal fue desactivado antes de poder enviarlo.';
        await this.runRepository.save(run);
        return;
      }

      await this.sendCompletionEmail(run);
    }
  }

  /**
   * Resuelve el snapshot semanal de `run`, creándolo si todavía no existe. `finalizedAnalysis`
   * viene seteado solo en el camino rápido (mismo tick en que reconcileRun detectó Analysis
   * 'Finalizado' arriba) — ahí se va directo a crear, igual que antes, confiando en el unique
   * (fieldId, weekStart, weekEnd) de WeeklyAnalysisSnapshotService.createFromAnalysis para el raro
   * caso de que otro tick concurrente haya ganado la carrera (ver su propio catch de 23505).
   *
   * Sin `finalizedAnalysis` (run que YA estaba 'completed' al empezar este tick) es el camino de
   * recuperación: se chequea primero si el snapshot ya existe (evita repetir el fetch+create en
   * cada tick de reconciliación una vez resuelto) y, si no, se vuelve a resolver el Analysis desde
   * `run.analysisId` antes de reintentar la creación — nunca se dispara un análisis nuevo.
   */
  private async ensureSnapshot(
    run: ScheduledAnalysisRun,
    finalizedAnalysis?: Analysis,
  ): Promise<WeeklyAnalysisSnapshot | null> {
    if (finalizedAnalysis) {
      return this.createSnapshotAndDiagnosis(run, finalizedAnalysis);
    }

    const existing = await this.weeklySnapshotService.findByScheduledRunId(
      run.id,
    );
    if (existing) {
      return existing;
    }

    const analysis = await this.resolveFinalizedAnalysis(run);
    if (!analysis) {
      return null;
    }

    return this.createSnapshotAndDiagnosis(run, analysis);
  }

  /**
   * Vuelve a leer (nunca recalcula) el Analysis de un run 'completed' sin snapshot. Solo verifica
   * existencia y `status === 'Finalizado'` — NUNCA valida que `resultJson` tenga una forma
   * compatible con lo que createFromAnalysis/extractSnapshotMetrics esperan. Eso es deliberado:
   * extractSnapshotMetrics ya es tolerante con resultJson parcial/legacy/null (degrada a métricas
   * "sin datos", nunca lanza por forma inesperada — ver weekly-analysis-snapshot-metrics.util.ts),
   * así que agregar un chequeo de compatibilidad acá sería validación redundante con riesgo real de
   * rechazar análisis legítimos más viejos. Si `resultJson` tuviera un problema que
   * extractSnapshotMetrics no absorbe (ej. columnas NOT NULL del snapshot como weekStart/weekEnd
   * quedando null en un Analysis muy viejo), esa falla ocurre recién dentro de
   * createSnapshotAndDiagnosis/createFromAnalysis — indistinguible en el log de una falla
   * transitoria de infraestructura. Riesgo preexistente conocido, no corregido acá (ver entrega).
   *
   * Un Analysis inexistente o que ya no está 'Finalizado' sí se distingue con su propio mensaje de
   * log explícito en vez de uno genérico de "no se pudo crear" — pero esto NO significa que se deje
   * de consultar: nada en el estado del run evita que el próximo tick de reconcilePendingRuns
   * vuelva a llamar a este método y repita exactamente la misma llamada a analysisService.findOne
   * (mismo costo que cualquier otra dependencia todavía sin resolver, ver CASO 6a/6b en el spec).
   */
  private async resolveFinalizedAnalysis(
    run: ScheduledAnalysisRun,
  ): Promise<Analysis | null> {
    if (!run.analysisId) {
      this.logger.error(
        `[scheduled-analysis] No se puede recuperar el snapshot semanal: run ${run.id} está 'completed' sin analysisId.`,
      );
      return null;
    }

    let analysis: Analysis;
    try {
      analysis = await this.analysisService.findOne(run.analysisId);
    } catch (error) {
      this.logger.error(
        `[scheduled-analysis] No se puede recuperar el snapshot semanal (runId=${run.id}): no se pudo obtener el Analysis ${run.analysisId}. ${this.describe(error)}`,
      );
      return null;
    }

    if (analysis.status !== 'Finalizado') {
      this.logger.error(
        `[scheduled-analysis] No se puede recuperar el snapshot semanal (runId=${run.id}): el Analysis ${run.analysisId} está en estado '${analysis.status}', no 'Finalizado' — dependencia irrecuperable sin reejecutar el análisis.`,
      );
      return null;
    }

    return analysis;
  }

  /**
   * Fase 5: snapshot semanal comparativo — se crea siempre que el análisis llega a Finalizado
   * (incluso con datos parciales/insuficientes, ver classifyDataQuality), nunca para un análisis
   * que falló. Idempotente por unique(fieldId, weekStart, weekEnd), así que un tick de
   * reconciliación que se solape con otro no duplica el snapshot.
   */
  private async createSnapshotAndDiagnosis(
    run: ScheduledAnalysisRun,
    analysis: Analysis,
  ): Promise<WeeklyAnalysisSnapshot | null> {
    let snapshot: WeeklyAnalysisSnapshot;
    try {
      snapshot = await this.weeklySnapshotService.createFromAnalysis(
        run,
        analysis,
      );
    } catch (error) {
      this.logger.error(
        `[scheduled-analysis] No se pudo crear el snapshot semanal (runId=${run.id}): ${this.describe(error)}`,
      );
      return null;
    }

    // PR 16B: diagnóstico semanal (weeklyTechnicalVerdict) — best-effort, propio try/catch
    // separado del snapshot de arriba: si el snapshot se creó bien pero esto falla, el snapshot ya
    // se creó igual (no se revierte) y el flujo sigue hacia el envío del email (ver PR 16A, sección
    // 8). Nunca depende de que el technicalVerdict individual exista o haya salido 'generated' — se
    // lee best-effort como contexto opcional, nunca se espera a que termine (evita heredar la
    // ventana de espera de 10 min que ya tiene el veredicto individual, ver
    // isWithinVerdictWaitWindow más abajo).
    try {
      const [field, individualVerdict] = await Promise.all([
        this.fieldsService.findByIdOrFail(run.fieldId),
        this.analysisVerdictService.findResponseByAnalysisId(analysis.id),
      ]);

      await this.weeklyTechnicalVerdictService.generateAndPersist(snapshot, {
        fieldName: field.name,
        individualVerdict: individualVerdict
          ? {
              verdict: individualVerdict.verdict,
              confidence: individualVerdict.confidence,
              summary: individualVerdict.summary,
            }
          : null,
      });
    } catch (error) {
      this.logger.error(
        `[scheduled-analysis] No se pudo generar el diagnóstico semanal (runId=${run.id}, snapshotId=${snapshot.id}): ${this.describe(error)}`,
      );
    }

    return snapshot;
  }

  private async sendCompletionEmail(run: ScheduledAnalysisRun): Promise<void> {
    if (!run.analysisId) {
      return;
    }

    // Fase 5: el email ahora se arma SIEMPRE desde el snapshot semanal comparativo, no solo del
    // Analysis — si todavía no existe (createFromAnalysis falló en un tick anterior, ver
    // reconcileRun), no inventamos un email genérico: se reintenta en el próximo ciclo, mismo
    // mecanismo que una falla transitoria de SMTP.
    const snapshot = await this.weeklySnapshotService.findByScheduledRunId(
      run.id,
    );

    if (!snapshot) {
      this.logger.error(
        `[scheduled-analysis] No se pudo enviar el email: todavía no hay snapshot semanal para runId=${run.id}. Se reintenta en el próximo ciclo.`,
      );
      return;
    }

    // PR 12A: solo LEE lo que AnalysisVerdictService ya generó y persistió al finalizar el
    // análisis (ver AnalysisService.processFieldAnalysisInBackground) — nunca llama a
    // generateAndPersist ni a Claude desde acá. Si todavía no existe fila y el run terminó hace
    // poco, se espera al próximo ciclo de reconcile en vez de mandar un mail incompleto de una vez.
    const technicalVerdict =
      await this.analysisVerdictService.findResponseByAnalysisId(
        run.analysisId,
      );

    if (!technicalVerdict && this.isWithinVerdictWaitWindow(run)) {
      this.logger.log(
        `[scheduled-analysis] Esperando el veredicto técnico antes de mandar el email (runId=${run.id}). Se reintenta en el próximo ciclo.`,
      );
      return;
    }

    // PR 16C: solo LEE lo que WeeklyTechnicalVerdictService ya generó y persistió en este mismo
    // tick de reconcileRun, justo después de crear el snapshot (ver PR 16B) — nunca llama a
    // generateAndPersist ni a Claude desde acá. Sin ventana de espera propia: a diferencia del
    // veredicto individual (que corre en background dentro de otro proceso async), este ya se
    // generó de forma síncrona antes de llegar acá en el mismo reconcileRun — si no existe, es
    // porque falló (best-effort, PR 16B) o el snapshot no tiene id, nunca por una carrera.
    const weeklyTechnicalVerdict =
      await this.weeklyTechnicalVerdictService.findResponseBySnapshotId(
        snapshot.id,
      );

    const [field, user] = await Promise.all([
      this.fieldsService.findByIdOrFail(run.fieldId),
      this.usersService.findById(run.userId),
    ]);

    if (!user) {
      this.logger.error(
        `[scheduled-analysis] No se pudo enviar el email: usuario ${run.userId} no existe (runId=${run.id}).`,
      );
      return;
    }

    const baseUrl = (
      this.configService.get<string>('APP_PUBLIC_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      ''
    ).replace(/\/$/, '');

    if (!baseUrl) {
      // FIX (auditoría predeploy): sin dominio configurado, el link quedaría como
      // "/app/analysis/…" sin host — roto en la mayoría de los clientes de correo, aunque el
      // envío se reporte como "exitoso". Mejor no mandar nada: queda 'completed' sin
      // emailSentAt, así que el próximo tick de reconciliación reintenta solo (mismo mecanismo
      // que una falla transitoria de SMTP) una vez que se corrija la config.
      this.logger.error(
        `[scheduled-analysis] No se pudo armar el link del email: APP_PUBLIC_URL/FRONTEND_URL no está configurado (runId=${run.id}). Se reintenta en el próximo ciclo.`,
      );
      return;
    }

    // Sin link directo al PDF con auth: GET /analysis/:id/report/pdf exige JwtAuthGuard (Bearer
    // token), que un link de email no puede llevar. reportUrl apunta a la vista previa del
    // informe en el frontend (autenticada por sesión de browser), desde donde el botón
    // "Descargar PDF" de esa página sí funciona — ver docs de Fase 4A / entregable final.
    const analysisUrl = `${baseUrl}/app/analysis/${run.analysisId}`;
    const reportUrl = `${baseUrl}/app/analysis/${run.analysisId}/report`;
    const comparison =
      (snapshot.comparisonVsPrevious as { summary?: string[] } | null)
        ?.summary ?? [];

    const result = await this.emailService.sendScheduledAnalysisEmail(
      user.email,
      {
        userName: user.fullName,
        fieldName: field.name,
        weekStart: snapshot.weekStart,
        weekEnd: snapshot.weekEnd,
        analysisUrl,
        reportUrl,
        dataQualityStatus: snapshot.dataQualityStatus,
        hasRgbImage: snapshot.hasRgbImage,
        hasNdviImage: snapshot.hasNdviImage,
        hasNdmiImage: snapshot.hasNdmiImage,
        hasImageSeries: snapshot.hasImageSeries,
        summary: comparison,
        technicalVerdict,
        weeklyTechnicalVerdict,
      },
    );

    if (result.sent) {
      run.emailSentAt = new Date();
      await this.runRepository.save(run);
      await this.scheduleRepository.update(run.scheduleId, {
        lastStatus: 'completed',
      });
    } else {
      this.logger.error(
        `[scheduled-analysis] No se pudo enviar el email de reporte semanal (runId=${run.id}) — se reintenta en el próximo ciclo.`,
      );
    }
  }

  /**
   * PR 12A: usa run.completedAt (seteado en reconcileRun apenas el Analysis llega a
   * 'Finalizado', ver arriba) en vez de agregar una columna de intentos nueva — es la marca de
   * tiempo más precisa ya disponible de "cuándo terminó esta corrida en particular". Sin
   * completedAt (no debería pasar para un run 'completed' real, pero es un dato externo) no hay
   * forma de medir la espera, así que no bloquea: se manda el mail sin veredicto.
   */
  private isWithinVerdictWaitWindow(run: ScheduledAnalysisRun): boolean {
    if (!run.completedAt) {
      return false;
    }

    return Date.now() - run.completedAt.getTime() < VERDICT_WAIT_WINDOW_MS;
  }

  // --- Ejecutar ahora (POST .../analysis-schedule/run-now) -----------------------------------

  async runNow(fieldId: string, userId: string): Promise<ScheduledAnalysisRun> {
    await this.fieldsService.findOne(fieldId, userId);

    const schedule = await this.scheduleRepository.findOne({
      where: { fieldId },
    });

    if (!schedule) {
      throw new BadRequestException(
        'Configurá el seguimiento semanal automático antes de poder ejecutarlo manualmente.',
      );
    }

    // FIX (auditoría predeploy): antes solo chequeaba que la fila existiera, no que estuviera
    // activa — un schedule desactivado (creado y después apagado) igual podía disparar una
    // corrida y terminar mandando un email, contradiciendo lo que el usuario acaba de pedir.
    if (!schedule.enabled) {
      throw new BadRequestException(
        'El análisis semanal está desactivado para este campo.',
      );
    }

    // SEC-008: mismo techo por usuario que el disparo manual de POST /analysis/field/:fieldId —
    // "Ejecutar ahora" es, para este propósito, un disparo manual más (comparte además el mismo
    // bucket de rate limit por usuario, ver UserComputeThrottlerGuard). Nunca se llama desde
    // processDueSchedules (el dispatcher automático llama a triggerRun directo, sin pasar por
    // acá) — ver el comentario completo en AnalysisService.assertUserBelowConcurrencyCeiling.
    await this.analysisService.assertUserBelowConcurrencyCeiling(userId);

    // triggerRun ya dedupea por (scheduleId, scheduledFor) — mismo mecanismo que usa el
    // dispatcher automático, así que "Ejecutar ahora" nunca duplica una corrida ya disparada
    // (automática o manual) para la semana actual.
    return this.triggerRun(schedule, new Date(), 'user_run_now');
  }

  private summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    return message.length > ERROR_MESSAGE_MAX_LENGTH
      ? `${message.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
      : message;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
