# Limpieza segura de datos QA/test en producción

## Por qué existe

Durante pruebas manuales de QA (incluyendo sesiones con Claude) contra la
base de producción se crearon usuarios de prueba y todos los datos
asociados que el flujo normal de la app genera para un usuario: campos,
lotes, análisis, veredictos técnicos, schedules semanales, runs,
snapshots, diagnósticos semanales, invitaciones y solicitudes de acceso.
Esos datos contaminan el panel admin (listados, funnel de producto, alertas
operativas) y se van a mezclar cada vez más con usuarios reales a medida
que el producto tenga tráfico genuino.

Este documento describe `src/scripts/cleanup-test-data.ts`: una
herramienta de un solo uso, controlada y auditable, para borrar esos datos
QA/test de forma segura. **No** es un endpoint del panel admin — es
deliberadamente un script interno que corre a mano, una vez, revisando el
reporte antes de confirmar nada.

## Diagnóstico del modelo de datos (real, no asumido)

Entidades relevantes y sus relaciones (ver cada `*.entity.ts` citado):

| Tabla | FK relevante | `onDelete` |
|---|---|---|
| `fields` | `userId` → `users` | `CASCADE`, NOT NULL |
| `field_lots` | `fieldId` → `fields` | `CASCADE` |
| `analysis` | **ninguna FK real** — `fieldId`/`lotId` son columnas `varchar` sueltas (ver `analysis.entity.ts`) | n/a |
| `analysis_technical_verdicts` | `analysisId` → `analysis` | `CASCADE`, unique |
| `field_analysis_schedules` | `fieldId` → `fields`, `userId` → `users` | `CASCADE` ambas |
| `scheduled_analysis_runs` | `scheduleId` → `field_analysis_schedules`, `fieldId` → `fields`, `userId` → `users` | `CASCADE` las tres |
| `weekly_analysis_snapshots` | `fieldId` → `fields`, `userId` → `users` | `CASCADE` ambas |
| `weekly_technical_verdicts` | `snapshotId` → `weekly_analysis_snapshots` | `CASCADE`, unique |
| `weekly_field_reports` | `fieldId` → `fields` (`CASCADE`), `userId` → `users` (`SET NULL`, nullable) | mixto |
| `weekly_lot_index_observations` | `weeklyReportId` → `weekly_field_reports` (`CASCADE`), `fieldId` → `fields` (`CASCADE`), `lotId` → `field_lots` (`SET NULL`) | mixto |
| `password_reset_tokens` | `userId` → `users` | `CASCADE` |
| `user_invitations` | `invitedByUserId` → `users` | `SET NULL`, nullable — no es "dueño", es quién invitó |
| `access_requests` | `assignedToUserId` → `users` | `SET NULL`, nullable — no es "dueño", es el admin asignado |
| `admin_audit_logs` | `actorUserId` → `users` (`SET NULL`); `targetType`/`targetId` **polimórficos, sin FK** | ver sección Audit logs |

Hallazgo importante del diagnóstico: **`analysis` no tiene ninguna
restricción de FK real** hacia `fields`/`field_lots` — son columnas
`varchar` sueltas. Esto significa que un `DELETE FROM fields` con cascade
de la base **nunca borraría los análisis** asociados; quedarían huérfanos.
Por eso este script no delega en el cascade de la DB en ningún paso: cada
tabla se borra explícitamente con el mismo predicado que se usa para
contar en dry-run (ver `cleanup-test-data.plan.ts`).

También se revisó la tabla legacy `lots` (no `field_lots`): es un remanente
de un modelo anterior a Field/FieldLot, sin columna `userId` ni relación
con `users`/`fields` (ver comentario en `src/data-source.ts` y
`src/lots/lots.controller.ts`, que devuelve `410 Gone` en los seis
endpoints). **Está fuera de alcance a propósito**: no hay forma de
asociarla a un usuario QA, y los endpoints que la tocaban ya están
deprecados desde antes de este ticket.

## Qué patrones detecta

Un usuario se marca como candidato QA/test si su **email** matchea
cualquiera de estos patrones (ver `QA_EMAIL_*` en
`cleanup-test-data.rules.ts`):

- termina en `@example.com`
- contiene `dashboard-ux`
- contiene `onboarding.`
- contiene `auth2-check`
- contiene `e2e`
- es exactamente `usera@example.com` o `userb@example.com`

O si su **nombre completo** contiene (sin distinguir mayúsculas): `qa`,
`e2e`, `test`, `empty`, `dashboard`, `onboarding`.

Las invitaciones (`user_invitations`) y solicitudes de acceso
(`access_requests`) se matchean **de forma independiente**, por su propio
campo `email`, con los mismos patrones de email de arriba — no dependen de
que exista un usuario ya creado (una invitación QA nunca aceptada también
se limpia).

## Qué bloquea (nunca se borra)

- **Emails protegidos explícitos** (nunca se borran, ni se muestran como
  candidato distinto): `slinares@agroscorelatam.com`,
  `no-reply@agroscorelatam.com`, `contacto@agroscorelatam.com`,
  `reportes@agroscorelatam.com`.
- **Cualquier email `@agroscorelatam.com`**, salvo que esté en la
  allowlist explícita `QA_DOMAIN_ALLOWLIST_EMAILS` en
  `cleanup-test-data.rules.ts` (vacía por default — agregar algo ahí es una
  decisión humana consciente, nunca un flag de CLI).
- **Cualquier usuario con rol `owner` o `admin`** que matchee un patrón
  QA — se muestra como **bloqueado**, nunca se borra.
- **Usuarios "ambiguos"**: el nombre matchea un patrón QA pero el email
  no matchea ningún patrón QA conocido. Esto es justamente "email fuera de
  patrones QA" — el detector no adivina, lo reporta y bloquea `--confirm`
  hasta que un humano lo revise (ajustando los patrones o el
  `fullName`/`email` del registro).

**Importante sobre el comportamiento de `--confirm`:** si hay *cualquier*
usuario bloqueado (dominio real, Owner/Admin) o ambiguo entre los
candidatos, o si la cantidad de usuarios "seguros" supera el máximo
esperado (`DEFAULT_MAX_SAFE_USERS = 200`, ajustable con
`--max-users=N`), **`--confirm` se aborta por completo sin borrar nada**,
incluso los usuarios que sí eran claramente seguros. El dry-run sigue
mostrando el reporte completo igual (para poder decidir cómo resolver el
bloqueo), pero no hay forma de "borrar los seguros e ignorar el resto" en
una misma corrida — es intencional: fuerza a revisar la lista completa
antes de tocar producción.

## Orden de borrado

Derivado de la tabla de FKs de arriba, hijos antes que padres (ver
`buildDeletionPlan()` en `cleanup-test-data.plan.ts`):

1. `weekly_technical_verdicts`
2. `weekly_lot_index_observations`
3. `weekly_analysis_snapshots`
4. `weekly_field_reports`
5. `scheduled_analysis_runs`
6. `field_analysis_schedules`
7. `analysis_technical_verdicts`
8. `analysis` (match manual por `fieldId`/`lotId`, sin FK real)
9. `field_lots`
10. `password_reset_tokens`
11. `user_invitations` (match independiente por email)
12. `access_requests` (match independiente por email)
13. `fields`
14. `users`

Cada paso usa exactamente el mismo predicado SQL para contar (dry-run,
`SELECT COUNT`) y para borrar (confirm, `DELETE ... RETURNING id`) — no hay
forma de que el número que ves en dry-run difiera de lo que realmente se
borra.

## Audit logs (`admin_audit_logs`): se conservan siempre

Regla del ticket: preferencia por conservar audit logs si no rompen FK.
Se revisó el modelo real (no se asumió nada):

- `actorUserId` es FK `ON DELETE SET NULL` — **no bloquea** el borrado de
  usuarios. Al borrar un usuario QA que actuó como admin en algún log
  (raro en la práctica, ver comentario en `admin-audit-log.entity.ts`), la
  propia base de datos pone `actorUserId = NULL` sola. Esto **no es un
  DELETE nuestro**, es el efecto documentado de la FK.
- `targetType`/`targetId` son polimórficos **sin FK real** (pueden apuntar
  a un user, access_request, analysis o invitation). Si un log tiene
  `targetType = 'user'` y `targetId` es un usuario QA borrado, ese log
  queda apuntando a un id que ya no existe — no hay ninguna restricción que
  lo impida ni que lo arregle sola.

Como ninguna FK bloquea nada, la decisión es **conservar siempre los audit
logs**, sin excepción, sin anonimizar y sin borrar. El script solo
**reporta** (nunca ejecuta) dos conteos informativos antes de cualquier
borrado:

- cuántos logs van a quedar con `actorUserId = NULL` (efecto de la FK)
- cuántos logs con `targetType='user'` van a quedar apuntando a un id
  borrado (advertencia, sin acción automática)

Si en el futuro se decide que este dangling reference es un problema real,
la opción a evaluar es anonimizar el `targetId` de esos logs puntuales —
pero eso queda fuera de este ticket a propósito ("no inventar").

## Cómo correr dry-run en producción

```bash
cd agro-score-api
npm run cleanup:test-data
# equivalente explícito:
npm run cleanup:test-data -- --dry-run
```

No requiere ningún flag adicional. Nunca abre una transacción de
escritura, sin importar lo que detecte. Conectate contra la base de
producción con las mismas variables de entorno (`DB_HOST`, `DB_NAME`, etc.)
que ya usa `npm run migration:*` — **no se toca `.env`** en ningún momento,
el script solo lee la configuración existente vía `src/data-source.ts`.

### Cómo guardar el output del dry-run

```bash
npm run cleanup:test-data -- --dry-run | tee cleanup-dry-run-$(date +%Y%m%d-%H%M).txt
```

Guardá ese archivo (fuera del repo, no lo commitees) como evidencia de qué
se planeaba borrar antes de correr `--confirm` — es el registro que
demuestra que se revisó la lista completa de usuarios/bloqueados/ambiguos
antes de tocar producción.

## Checklist antes de correr `--confirm` en producción

1. [ ] Hacer un **backup de la base de producción** (dump completo o
   snapshot del proveedor) inmediatamente antes de correr `--confirm`. El
   script corre todo dentro de una transacción (rollback automático ante
   cualquier error), pero un backup es la única red de seguridad real ante
   un error humano en los patrones/allowlist.
2. [ ] Correr `--dry-run` y guardar el output (ver arriba).
3. [ ] Revisar a mano, en el output, **cada** usuario en "Usuarios
   detectados para borrar (safe)": ¿son todos genuinamente de prueba?
4. [ ] Confirmar que la sección "Usuarios bloqueados por seguridad" está
   vacía. Si no lo está, no se puede correr `--confirm` — resolver primero
   (¿es realmente un usuario real que matcheó por accidente? ¿es un test
   legítimo que hay que agregar a `QA_DOMAIN_ALLOWLIST_EMAILS`?).
5. [ ] Confirmar que la sección "Usuarios ambiguos" está vacía. Si no,
   mismo criterio que el punto anterior.
6. [ ] Revisar los conteos por tabla — ¿el volumen es el esperado para la
   cantidad de usuarios QA involucrados, o hay algo que sugiere que el
   patrón está capturando de más?
7. [ ] Correr en un horario de bajo tráfico.
8. [ ] Recién ahí, correr `--confirm` (ver comando abajo) y guardar
   también ese output.

## Cómo correr confirm en producción

```bash
cd agro-score-api
npm run cleanup:test-data -- --confirm | tee cleanup-confirm-$(date +%Y%m%d-%H%M).txt
```

Si hay cualquier advertencia bloqueante (usuarios bloqueados, ambiguos, o
más usuarios "seguros" que el máximo esperado), el comando **no borra
nada**, imprime el mismo reporte que el dry-run más la sección de
advertencias, y termina con exit code `1`. Solo si no hay ninguna
advertencia bloqueante abre la transacción y ejecuta el plan de borrado
completo en el orden de la sección anterior.

Flag opcional avanzado: `--max-users=N` sube el límite de
`DEFAULT_MAX_SAFE_USERS` (200) si genuinamente hay más de 200 usuarios QA
legítimos para borrar en una sola corrida — usar con criterio, después de
haber revisado la lista completa en dry-run.

## Tests

`cleanup-test-data.rules.spec.ts`, `.plan.spec.ts` y `.core.spec.ts` cubren
el detector y el planificador (patrones, bloqueos, orden de borrado,
dry-run vs. confirm) sin tocar ninguna base de datos real — usan una DB
falsa en memoria. **Ningún test ejecuta la limpieza contra producción ni
contra ninguna base real.** El único archivo que abre una conexión real
(`AppDataSource`) es `cleanup-test-data.ts`, y ningún `.spec.ts` lo
importa.
