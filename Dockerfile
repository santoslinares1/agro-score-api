# syntax=docker/dockerfile:1
# DEPLOY-AWS-1: imagen productiva del backend NestJS. Multi-stage para no
# empaquetar devDependencies ni herramientas de build en la imagen final.
#
# Nota: el output real de `nest build` es dist/src/main.js (sourceRoot=src
# en nest-cli.json), NO dist/main.js como sugiere el script "start:prod" de
# package.json (desactualizado — no se toca acá, es un cambio de código
# fuera de alcance de esta ficha; documentado en deploy-aws-1.md).

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN addgroup -S agroscore && adduser -S agroscore -G agroscore
USER agroscore

EXPOSE 3001

# No corre migrations automáticamente: correrlas es un paso manual y
# controlado (ver deploy/aws/README.md, sección Migraciones).
CMD ["node", "dist/src/main.js"]
