# Preclasificación — propuesta de SQL

Fecha: 2026-11-11. **Nada de esto se ejecutó.** Es la propuesta completa, con su
impacto y su reversión, para que JP decida y lo aplique él.

El diseño que justifica cada columna está en [`02-diseno-v1.md`](02-diseno-v1.md).

---

## 0. Antes de ejecutar nada — tres cosas

1. **Comparar contra el DDL vivo.** Esta propuesta se escribió leyendo las
   migraciones del repo y las columnas reales por REST, pero el DDL vivo de las vistas
   y funciones no se pudo leer desde la sesión (solo `GET`). Ya pasó una vez que la
   vista viva no era la del repo: `sofia_followup_queue` cambió fuera de git y
   reescribirla desde el repo habría revertido las pacientes programadas. **Antes de
   correr esto hay que mirar el DDL vivo de `sofia_followup_queue` y de
   `sofia_home_stats`** — aunque esta propuesta no los toca, conviene saber qué hay.
2. **El orden importa.** Las columnas van **antes** del despliegue del Worker. El
   código las lee y escribe en cada turno; sin ellas, cada conversación del flujo deja
   un error en el log. La conversación se atiende igual, pero el ruido tapa lo que sí
   importa. Es el orden que se usó el 10 de noviembre.
3. **Comprobar que la escritura volvió.** En Supabase un rechazo no siempre es un
   error visible: el diagnóstico de atribución estuvo un mes escribiendo contra un
   `CHECK` que lo rechazaba y nadie miró la respuesta. Después de aplicar, se hace un
   `select` de las columnas nuevas y se confirma que existen y que el primer turno del
   flujo escribió algo.

---

## 1. El interruptor y los criterios — `sofia_config`

```sql
-- Preclasificación de pacientes quirúrgicas — configuración.
--
-- Las tres columnas van juntas y se leen en el mismo select de
-- loadSofiaConfig(), así que no agregan ninguna consulta por mensaje.
--
-- POR QUÉ EN sofia_config Y NO EN knowledge_base
--
-- La base de conocimiento llega a Sofía por búsqueda semántica, o sea que a
-- veces no llega: solo la sección de promociones y los nombres de las secciones
-- 4 y 5 se extraen por código y van siempre. Un criterio médico que a veces no
-- llega es peor que no tenerlo. Ya pasó con FaceTite, AccuTite y BodyTite, que
-- callaban el costo de la valoración porque la regla general no llegaba.
--
-- POR QUÉ NO EN UN ARCHIVO DEL REPO
--
-- Cambiar un criterio exigiría `wrangler deploy`, y los criterios los van a
-- editar los cirujanos.

alter table public.sofia_config
  add column if not exists preclasificacion_enabled boolean not null default false;

alter table public.sofia_config
  add column if not exists preclasificacion_procedimientos text[] not null default '{}';

alter table public.sofia_config
  add column if not exists preclasificacion_criterios text;

comment on column public.sofia_config.preclasificacion_enabled is
  'Interruptor del flujo de preclasificación quirúrgica. En false, Sofía se '
  'comporta exactamente como antes del flujo: el bloque del prompt no se inyecta '
  'y no se escribe ninguna columna nueva de sofia_conversations.';

comment on column public.sofia_config.preclasificacion_procedimientos is
  'Procedimientos con criterio médico aprobado. ARRANCA VACÍA a propósito: con '
  'la lista vacía el flujo no se activa para nadie, ni siquiera con el '
  'interruptor encendido. Se llena a medida que los cirujanos aprueban criterios.';

comment on column public.sofia_config.preclasificacion_criterios is
  'Texto de los criterios médicos aprobados, con su versión y fecha en la primera '
  'línea (ej. "CRITERIOS v1 — 2026-11-20"). El Worker lo concatena al final del '
  'bloque del system prompt, no en un bloque nuevo: el caché de la API acepta 4 '
  'bloques y ya se usan 3. Si está vacío y la lista de procedimientos no, el '
  'bloque NO se inyecta y queda un warn: es un error de configuración.';
```

**Impacto.** `sofia_config` tiene **1 fila**. Las tres columnas son nuevas, con valor
por defecto seguro: `preclasificacion_enabled = false` deja el sistema idéntico a hoy.
No hay bloqueo apreciable ni reescritura de tabla.

**Qué queda igual.** Los cinco campos que `loadSofiaConfig()` ya lee, el
`system_prompt`, el `knowledge_base` y los demás interruptores. Nada se modifica.

---

## 2. El resultado por conversación — `sofia_conversations`

```sql
-- Preclasificación: el resultado, por paciente.
--
-- MINIMIZACIÓN — lo que NO está acá, a propósito:
--
--   * el peso y la estatura crudos. Se usan en memoria para calcular el IMC y
--     se descartan. Si mañana cambia la fórmula, se recalcula leyendo las
--     conversaciones, no la base.
--   * cualquier texto clínico libre. Las señales son una lista cerrada de
--     categorías que escribe el código, no el modelo.
--   * un diagnóstico. "revisión médica" no es un diagnóstico: es que lo mire
--     una persona.
--
-- SIN CHECK, A PROPÓSITO
--
-- Los valores válidos de `preclasificacion` ('A','B','C','D') se validan en el
-- código. Un CHECK nuevo sin su migración rechaza cada insert y no deja rastro
-- si nadie mira la respuesta: el diagnóstico de atribución perdió un mes así.
-- El costo de no tenerlo es un valor raro en una columna; el de tenerlo mal es
-- perder la escritura entera.

alter table public.sofia_conversations
  add column if not exists preclasificacion text;

alter table public.sofia_conversations
  add column if not exists imc_orientativo numeric(4,1);

alter table public.sofia_conversations
  add column if not exists preclasificacion_senales text[];

alter table public.sofia_conversations
  add column if not exists preclasificacion_version text;

comment on column public.sofia_conversations.preclasificacion is
  'A = cumple los criterios iniciales · B = revisión médica · C = no cumple un '
  'criterio aprobado · D = prioritaria por señal de alarma. En la v1 el estado C '
  'NO se le comunica a la paciente: se trata como B y la noticia la da una '
  'persona. Lo escribe el código a partir de los criterios, no el modelo.';

comment on column public.sofia_conversations.imc_orientativo is
  'Solo si la paciente dio peso y estatura por su cuenta. Es orientativo y NUNCA '
  'se le menciona a la paciente. Medido el 2026-11-11: solo el 0,4% de las '
  'conversaciones trae los dos datos, así que esta columna va a estar casi '
  'siempre vacía y eso es lo esperado, no una falla.';

comment on column public.sofia_conversations.preclasificacion_senales is
  'Lista cerrada de categorías observadas en lo que dijo la paciente: '
  'cambio_peso, embarazo_o_parto_reciente, cirugia_previa, condicion_cronica, '
  'anticoagulante, fuma, sintoma_de_alarma. Sin texto libre y sin interpretación '
  'clínica. Es pegajosa: un dato obtenido no se borra en el turno siguiente.';

comment on column public.sofia_conversations.preclasificacion_version is
  'La versión de criterios que se aplicó a esta paciente, copiada de la primera '
  'línea de sofia_config.preclasificacion_criterios. Sin esto, una '
  'clasificación vieja no se puede interpretar después de que los criterios '
  'cambien.';

-- Índice parcial: las consultas del dashboard filtran por clasificación y la
-- gran mayoría de las filas la va a tener nula (el flujo solo aplica a una
-- lista corta de procedimientos).
create index if not exists sofia_conversations_preclasificacion_idx
  on public.sofia_conversations (preclasificacion)
  where preclasificacion is not null;
```

**Impacto.** `sofia_conversations` tiene **26.087 filas**. Las cuatro columnas son
nullables y **sin valor por defecto**, así que en PostgreSQL el `alter table` es un
cambio de metadatos: no reescribe la tabla y no bloquea la escritura más que un
instante. El índice parcial se crea sobre cero filas.

**Lo que no cambia.** Ninguna columna existente, ningún tipo, ninguna restricción.

**Las vistas y funciones.** `sofia_followup_queue`, `sofia_home_stats`,
`sofia_followup_candidates` y `sofia_pacientes` fijan su lista de columnas al
crearse, así que **agregar columnas no las altera ni las rompe**. Tampoco las usa esta
propuesta: la decisión 3 de JP deja el texto de `escalation_reason` sin prefijo
justamente para no tocarlas.

---

## 3. El respaldo de los criterios — `sofia_config_backups`

Esto es la decisión 6 de la auditoría, y es de JP.

Hoy `sofia_config_backups` tiene **34 filas** y una sola columna de contenido:
`system_prompt`. Si los criterios médicos viven en `sofia_config` y nadie los
respalda, **un criterio pisado no tiene vuelta atrás** — y el historial del prompt
existe precisamente porque `sofia_config.updated_at` no sirve para reconstruirlo.

```sql
-- Los criterios médicos son configuración de producción igual que el prompt, y
-- los va a editar más de una persona. Sin respaldo, un criterio sobrescrito se
-- pierde: sofia_config no guarda historial y updated_at no se toca cuando el
-- script sube el prompt.
alter table public.sofia_config_backups
  add column if not exists preclasificacion_criterios text;

comment on column public.sofia_config_backups.preclasificacion_criterios is
  'Copia de sofia_config.preclasificacion_criterios al momento del respaldo. '
  'Nullable: los 34 respaldos anteriores a noviembre de 2026 no tienen criterios '
  'porque la columna no existía.';
```

**Impacto.** 34 filas, columna nullable. Nada más.

**Lo que falta además del SQL:** que quien guarde un respaldo copie también esta
columna. Hoy los respaldos se crean a mano; si se automatizan, tiene que entrar acá.

---

## 4. Reversión

El orden de la reversión es el inverso del de aplicación: primero se apaga el
interruptor (que deja de escribir), después se quitan las columnas.

```sql
-- PASO 1 — apagar, sin perder nada. Esto solo ya devuelve a Sofía al
-- comportamiento anterior: el bloque del prompt no se inyecta y no se escribe
-- ninguna columna nueva. Es reversible al instante y es lo que hay que hacer
-- primero si algo sale mal en producción.
update public.sofia_config set preclasificacion_enabled = false;

-- PASO 2 — quitar las columnas. OJO: esto SÍ borra datos. Las clasificaciones
-- y las señales de las pacientes que pasaron por el flujo se pierden y no se
-- pueden reconstruir sin volver a leer las conversaciones.
drop index if exists public.sofia_conversations_preclasificacion_idx;

alter table public.sofia_conversations drop column if exists preclasificacion_version;
alter table public.sofia_conversations drop column if exists preclasificacion_senales;
alter table public.sofia_conversations drop column if exists imc_orientativo;
alter table public.sofia_conversations drop column if exists preclasificacion;

alter table public.sofia_config_backups drop column if exists preclasificacion_criterios;

alter table public.sofia_config drop column if exists preclasificacion_criterios;
alter table public.sofia_config drop column if exists preclasificacion_procedimientos;
alter table public.sofia_config drop column if exists preclasificacion_enabled;
```

**El orden del paso 2 no es decorativo:** si se quitan las columnas de `sofia_config`
mientras el Worker desplegado las lee, `loadSofiaConfig()` falla y Sofía deja de
responder. La reversión completa se hace **después** de desplegar un Worker que ya no
las lea, o aceptando la ventana de error. El paso 1 no tiene ese problema y por eso es
el que se usa en una emergencia.

---

## 5. Lo que esta propuesta NO incluye

- **Ninguna migración a `sofia_followup_queue`, `sofia_home_stats` ni
  `motivos.js`.** Es la decisión 3 de JP: sin prefijo en el motivo, el dashboard
  agrupa y puntúa igual que hoy y no hay nada que cambiar.
- **Ninguna columna para el tope de turnos.** El tope efectivo se calcula leyendo el
  historial que ya está en memoria (4.6 del diseño).
- **Ninguna columna para la tercera cola.** Se generaliza el disparador de la que
  existe, no se agrega otra.
- **Ningún `CHECK`, ningún `not null` sobre tablas con datos, ningún cambio de tipo.**
- **Ningún `RLS` nuevo.** Las columnas nuevas heredan las políticas de su tabla. Si
  `anon` puede leer `sofia_conversations` por alguna política existente, va a poder
  leer estas columnas: **eso hay que verificarlo antes de aplicar**, porque
  `preclasificacion_senales` es dato de salud.

---

## 6. Checklist para aplicarlo

1. Mirar el DDL vivo de `sofia_followup_queue` y `sofia_home_stats` (sección 0).
2. Verificar las políticas de RLS de `sofia_conversations` (sección 5).
3. Correr la sección 1 (`sofia_config`). Confirmar con un `select` que las tres
   columnas existen y que `preclasificacion_enabled` quedó en `false`.
4. Correr la sección 2 (`sofia_conversations`) y la 3 (`sofia_config_backups`).
5. Dejar el archivo de migración en `cecmarketing/supabase/migrations/` con la fecha
   real de aplicación y la nota de que se aplicó a mano, como las del 9 y el 10 de
   noviembre.
6. **Solo después** desplegar el Worker.
7. Encender el interruptor **sin** cargar la lista de procedimientos, y verificar que
   nada cambió: el bloque del prompt no se inyecta con la lista vacía.
8. Cargar el primer procedimiento con su criterio aprobado, y mirar las primeras
   conversaciones una por una.
