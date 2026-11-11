# Preclasificación de pacientes — Parte 1: auditoría

Fecha: 2026-11-10. Rama: `feature/preclasificacion`. **No se modificó código**: todo
lo de abajo es lectura del repo, del prompt vivo y de la base, más cuatro
mediciones sobre datos reales.

Las líneas citadas son de `src/index.js` en `feature/preclasificacion`, que sale de
`main` (`1870bb1`, el mismo commit que tiene GitHub).

---

## 0. Estado de los dos repos — hay algo que decidir antes de seguir

### `cec-sofia-whatsapp`

- Árbol de trabajo **limpio** y `main` **a la par de `origin/main`** en `1870bb1`,
  verificado con `git ls-remote origin main` contra el remoto de verdad.
- **Corrección de esta misma auditoría.** La primera versión decía que había 5
  commits del 9 y 10 de noviembre sin subir. Era un dato viejo: el `git fetch` con
  que arrancó la sesión no actualizó la referencia local del remoto, que se había
  quedado en `99c287b` del 5 de noviembre (consta en el reflog de
  `refs/remotes/origin/main`). Esos commits ya estaban en GitHub. El `git push`
  posterior no tuvo nada que enviar y lo único que hizo fue corregir la referencia
  local.
- De ese episodio queda la lección de método, que sí vale y es la misma que el
  README ya advierte en otra dirección: **`git log` no dice qué corre en producción,
  y la referencia local del remoto no dice qué hay en GitHub.** Para lo primero, se
  llama a un endpoint; para lo segundo, `git ls-remote`.
- Lo que sí quedó verificado por dato, no por `git log`: **el código del 10 de
  noviembre está desplegado.** La columna `sofia_conversations.ofrecimiento_sin_
  respuesta_desde`, que solo escribe `48365fa`, tiene 6 filas marcadas y la última
  es de hoy a las 22:47 UTC.

### `cecmarketing`

Limpio y a la par de `origin/main` (`c0bc163`). Rama `feature/preclasificacion`
creada, todavía vacía.

### Acceso a la base

El MCP de Supabase de esta sesión apunta a **otro proyecto** (`CEC Colaboradores`,
la intranet): no tiene ninguna tabla `sofia_*`. El proyecto de Sofía se leyó por
REST con la llave de servicio de `cecmarketing/.env.local`, **solo con `GET`**.
Consecuencia para esta auditoría: se pueden leer filas y columnas, pero **no el DDL
vivo** de las vistas y funciones. Donde eso importa (sección 6.5) se dice.

---

## 1. El prompt vivo, en las partes que importan

`sofia_config`, una sola fila, leída hoy:

| campo | valor |
|---|---|
| `system_prompt` | 58.584 caracteres, 382 líneas, 36 secciones |
| `knowledge_base` | 135.579 caracteres |
| `whatsapp_enabled` | `true` |
| `followup_enabled` | `true` |
| `followup_primer_mensaje_enabled` | `true` |
| `atencion_nocturna_enabled` | **`true`** |
| `escalation_round_robin_index` | 5005 |
| `updated_at` | 2026-10-03 (no sirve: el script sube el prompt sin tocar la fecha; la historia real está en `sofia_config_backups`) |

Dos cosas de esa tabla cambian el planteo de la Parte 2:

1. **La atención nocturna está encendida.** El documento de diseño la daba por
   apagada. Encendida, el tope de mensajes de noche es 20 y no 10, y Sofía sigue
   conversando fuera de horario en vez de callarse.
2. **No existe ninguna columna `preclasificacion_enabled`.** El interruptor de 2.1
   necesita migración.

### 1.1 Tamizaje — sección "Preguntas de screening…" (líneas 269-325 del prompt)

Lo que hay que leer dos veces, porque es el conflicto central de todo este trabajo:

> Esta sección aplica cuando se cumplen LAS DOS cosas a la vez: es una cirugía de la
> sección 4 de la BASE DE CONOCIMIENTO, Y reforma senos, abdomen, cintura, espalda,
> glúteos, brazos o muslos. Si falla cualquiera de las dos, no aplica.

> La prohibición es de CONDUCTA, no de etiqueta. No se trata solo de no "correr el
> tamizaje": es que en una conversación donde esta sección no aplica no preguntas por
> embarazo, lactancia ni cambio de peso de NINGUNA forma. Tampoco si la reformulas
> ("necesito confirmarle un par de cosas rápidas", "un dato más antes de coordinar"),
> ni si la justificas con un antecedente de la paciente —hilos, cirugías previas, una
> condición médica, la edad—, ni si la presentas como consulta al equipo médico.

Y el resto de las reglas vigentes, resumidas:

- **Cuándo**: solo cuando la paciente ya mostró intención concreta de agendar.
  Preguntar el precio **no** cuenta como intención.
- **Cómo**: de una en una, nunca las tres juntas, y con una frase que explica el
  porqué y **nombra la cirugía concreta**.
- **Antes de cada pregunta**: revisar si la conversación ya la contestó (la edad,
  los hijos, la menopausia).
- Si no contesta: se repite una vez al final del mensaje siguiente, y **no hay
  tercera vez**; lo que falte se anota en el motivo del traspaso.
- Si alguna da positivo: no se sigue coordinando, se explica con la razón de la
  base y va `[PROGRAMAR: motivo | fecha]`.
- Nada de esto se traslada a los tratamientos no quirúrgicos de la sección 5.

### 1.1b Una corrección al planteo: la valoración cuesta ₡70.000

El planteo lista entre las reglas vigentes *"el precio de la valoración
(₡65.000)"*. El prompt vivo dice otra cosa, y lo dice blindado (línea 248):

> El precio de la valoración quirúrgica es ₡70,000: ₡35,000 al agendar y ₡35,000 el
> día de la cita… Los dos únicos montos que puedes escribir sobre la valoración son
> ₡70,000 y ₡35,000. Cualquier otro es un error, por correcto que suene.

₡65.000 es justamente la cifra que Sofía inventaba y que esa regla vino a frenar.
Ningún texto de este trabajo puede repetirla, ni como ejemplo.

### 1.2 Escalamiento (líneas 131-145 y 153-171)

- "Qué no puedes responder" ya manda escalar por **candidatura médica**: *"cualquier
  pregunta sobre si un procedimiento o el equipo médico puede atender su caso
  particular"*, con una excepción —si la base dice explícitamente que el
  procedimiento excluye la condición, se le dice y **además** se escala.
- Síntomas post-operatorios o emergencias → escalar de inmediato (y responder en el
  idioma del mensaje).
- El motivo lo lee alguien que no vio la conversación; prohibido el motivo genérico;
  **prohibido poner en el motivo un dato que la paciente no dio**; y si el tamizaje
  quedó incompleto, se anota qué falta.
- En el mensaje que escala no se piden más datos clínicos: *"eso ya es del equipo
  médico"*.

Es decir: **el estado B del diseño (revisión médica) ya existe en el prompt** como
regla de candidatura, y el D (urgencias) también. Lo nuevo de la v1 no es el
destino, es el interrogatorio previo.

### 1.3 Orden de la conversación (líneas 54-98 y 326-331)

Máximo 4 líneas y **un solo mensaje por mensaje de la paciente**; "un mensaje de la
paciente = una respuesta de Sofía = esperar". Cualquier pregunta clínica nueva
ocupa, por diseño, un turno entero.

---

## 2. El recorrido de un mensaje

| # | paso | dónde |
|---|---|---|
| 1 | `POST /webhook` (valida `WEBHOOK_SHARED_SECRET`) | `src/index.js:714` → `:867` |
| 2 | Saca los mensajes entrantes del payload; descarta el eco de los agentes (`performer !== "integration"`) | `:955`, `:986` |
| 3 | Captura el paquete crudo para el diagnóstico de atribución | `:1084` |
| 4 | `processInboundMessage()` | `:1228` |
| 5 | Dedup atómico por PK de Postgres | `claimInteraction()` `:1121` |
| 6 | Freno de emergencia `whatsapp_enabled` | `:1260` |
| 7 | Espera 10 s por si viene una ráfaga | `agruparMensajesSeguidos()` `:1175` |
| 8 | ¿La tiene un humano? Consulta en vivo a Zenvia, falla cerrado | `getCurrentProspectAgentId()` `:4076` |
| 9 | Estado + historial (20 turnos) | `getConversationState()` `:3641`, `getOrCreateSession()` `:3530` |
| 10 | ¿Ya escalada? Entonces silencio, salvo `archived`, reasignación a Sofía o 48 h de enfriamiento | `:1341-1400` |
| 11 | Tope de 10 mensajes (20 de noche): filtro de "no paciente", diferimiento, o traspaso | `:1459`, `:1483`, `:1505` |
| 12 | RAG (6 fragmentos, umbral 0,45) + fichas nombradas | `ragSearch()` `:2987`, `sumarFichasNombradas()` `:3281` |
| 13 | Armado del system: prompt, catálogo, promociones, fragmentos, hora | `buildSystemBlocks()` `:3303` |
| 14 | Nota nocturna inyectada en el historial | `conNotaNocturna()` `:262` |
| 15 | Claude Sonnet, con 3 reintentos | `callClaude()` `:3475` |
| 16 | Parseo de etiquetas `[ESCALAR]` `[CERRAR]` `[NO_RESPONDER]` `[PROGRAMAR]` | `parseEscalation()` `:2556` |
| 17 | Cuatro redes que escalan sin etiqueta | `:1779`, `:1797`, `:1808`, `:1821` |
| 18 | Decisión: diferir / esperar un turno / escalar ahora | `:1859`, `:1923`, `:1931` |
| 19 | Clasificación con Haiku (incluye el tamizaje) | `classifyEscalationWithHaiku()` `:4329` |
| 20 | Nota interna en Zenvia | `addEscalationNote()` `:4278` |
| 21 | Traspaso por round-robin a uno de los 4 asesores | `transferToNextAgentInPool()` `:4618` |
| 22 | Registro del traspaso | `registrarHandoff()` `:4698` |
| 23 | Guardado de la sesión y de la conversación | `saveSessionWithRetry()` `:3566`, `upsertConversation()` `:3761` |
| 24 | Marcas de las tres colas | `:2128`, `:5033`, `:5048`, `:6686` |

### Dos cosas del recorrido que el planteo daba por otra cosa

**La nota interna lleva SOLO el motivo.** `addEscalationNote()` (`:4278`) manda
exactamente `TRASPASO DE SOFÍA\nMotivo: <motivo>`. El README sección 1.5b todavía
dice que lleva los últimos 2 mensajes: **el README está desactualizado**, el
planteo tiene razón.

**`[ESCALAR]` no es la única puerta.** Hay siete textos distintos de
`escalation_reason` y cinco los escribe el código, no Sofía (`:1832`):

| de dónde sale | texto del motivo |
|---|---|
| `[ESCALAR: motivo]` | lo que escribió Sofía |
| promesa de contacto sin etiqueta | `frase de traspaso detectada sin etiqueta [ESCALAR]` |
| difirió el dato al equipo | `difirió el precio al equipo sin etiqueta [ESCALAR]` |
| la paciente pidió cita y Sofía no escaló | `pidió cita y Sofía no la escaló — la paciente escribió: "…"` |
| tope de mensajes | `límite de mensajes alcanzado` |
| falla de Claude | `falla_tecnica_claude` |
| los tres barridos | `conversación larga fuera de horario sobre …`, y los de las colas |

Esto importa para el prefijo de 2.5: **un prefijo solo se le puede poner a la
primera fila de esa tabla.** Las otras seis quedarían sin prefijo, y son las que
hoy alimentan el grupo "Cierre del sistema" del dashboard.

---

## 3. Qué se reutiliza, qué se extiende, qué no se toca

### Se reutiliza tal cual

- `[ESCALAR: motivo]`, el round-robin, la nota, `registrarHandoff()`.
- `[PROGRAMAR]` entero (`:2597`-`:2648`): los tres motivos, `ESPERA_MESES`, el
  cálculo de la fecha y `programarSeguimiento()`.
- `[NO_RESPONDER]`, `[CERRAR]`, el dedup, el freno de emergencia, la agrupación de
  ráfagas, la atención nocturna y los tres barridos.
- `esUrgente()` / `MOTIVO_URGENTE` (`:135`) — pero ojo con 6.4.

### Hay que extender

- `loadSofiaConfig()` (`:2713`): lee cinco campos y hay que agregarle el
  interruptor y los criterios. Es un solo `select`, sin costo extra por mensaje.
- `classifyEscalationWithHaiku()` (`:4329`): campos nuevos en el JSON. Con la
  trampa de 6.7.
- `upsertConversation()` (`:3761`): columnas nuevas, con la misma regla pegajosa
  del tamizaje (`:3836`).
- `buildSystemBlocks()` (`:3303`): un bloque más. Con el techo de 4 bloques
  cacheados (sección 4).
- `PREGUNTAS_DEL_TAMIZAJE` (`:2328`): si no se extiende, la tercera cola no ve las
  preguntas nuevas (6.6).

### No se toca

El tramo 8-10 del recorrido (quién es el dueño de la conversación, el enfriamiento
de 48 h, el silencio tras escalar), `claimInteraction()`, `sendChannelMessage*()`,
`resolveInboundContent()`, el RAG y su umbral, el bloque de fragmentos sin cachear,
y las vistas y funciones de la base que leen `escalation_reason`.

---

## 4. Dónde poner los criterios clínicos

### La restricción dura: el caché

`buildSystemBlocks()` (`:3303`) ya manda **tres bloques con `cache_control`** en el
camino normal (prompt, catálogo de tratamientos, promociones) y **la API acepta
cuatro como máximo**. Después van los fragmentos del RAG —que no se cachean a
propósito, está medido: cachearlos cuesta ~$25/mes de más— y la fecha y hora, que
tiene que quedar última porque cambia en cada request.

Un bloque nuevo cacheado es exactamente el cuarto. Entra, pero no queda ninguno de
sobra para lo que venga después.

### Las tres opciones

| | a favor | en contra |
|---|---|---|
| **Sección nueva de `knowledge_base`** | ya hay procedimiento escrito y re-indexado (`scripts/sofia-base.mjs`); los cirujanos lo editan desde el dashboard | **llega por RAG, o sea que a veces no llega.** Solo la sección 6 (promociones) y los nombres de las 4 y 5 se extraen por código y van siempre. Una regla general que depende de la similitud es la falla ya conocida: "una regla general no llega, la ficha sí" |
| **Columna nueva en `sofia_config`** | llega en el 100% de los mensajes; se lee en el mismo `select` que ya existe; se apaga y se enciende sin desplegar | hay que decidir si va pegada al bloque del prompt (un solo slot de caché, pero cambiarla invalida el caché del prompt una vez) o en su propio bloque (el cuarto y último); no queda versionada sola — `sofia_config_backups` hoy respalda el prompt |
| **Archivo versionado en el repo** | versión y diff gratis con git; revisión antes de publicar | **cambiar un criterio exige `wrangler deploy`**, y los cirujanos no lo hacen; además duplica el problema de los dos repos espejo |

### Recomendación

**Columna nueva en `sofia_config`, concatenada al final del bloque del prompt** (el
mismo slot de caché, no uno nuevo). Razones, en orden:

1. Llega siempre. Un criterio médico que a veces no llega es peor que no tenerlo.
2. No consume el cuarto slot de caché.
3. El costo es un único re-escrito del caché el día que los cirujanos cambien un
   criterio — eso pasa pocas veces al mes y el TTL es de 1 hora.
4. La versión y la fecha van **dentro del texto** (`CRITERIOS v1 — 2026-11-xx`), se
   guardan en la columna nueva de `sofia_conversations` y el cambio se anota en el
   registro de `docs/Sofia-Base-de-Conocimiento.md`, como manda el CLAUDE.md.

Lo que falta decidir y es de JP: si esa columna debe respaldarse en
`sofia_config_backups` como el prompt. Sin eso, un criterio pisado no tiene vuelta
atrás.

---

## 5. Riesgos de tocar cada componente

| componente | qué puede pasar | qué tan silencioso |
|---|---|---|
| `system_prompt` | el bloque nuevo contradice la prohibición de conducta de 1.1 y Sofía pregunta por embarazo donde está prohibido; ya pasó con las tres actuales (98 señoras que ya habían dicho su edad, 18 hombres) | **muy silencioso**: nadie se queja, se ve recién al leer conversaciones |
| `buildSystemBlocks()` | un quinto `cache_control` → la API rechaza, o peor: el bloque nuevo antes de uno cacheado invalida el prefijo en **cada** mensaje y la factura se multiplica sin que Sofía responda distinto | el más caro de todos; se vigila con `SOFIA_USAGE.cache_lectura` |
| `classifyEscalationWithHaiku()` | un campo nuevo mal parseado tira el `catch` y se pierden también `label`, `procedure_interest`, `sentiment` y el tamizaje de ese turno | medio: hay `console.error` |
| `upsertConversation()` | sin la regla pegajosa, el dato clínico se borra al turno siguiente (es la lección del 29 de setiembre con `escalation_reason`) | **silencioso** |
| `escalation_reason` | cambiarle el texto mueve el puntaje de la cola de Seguimiento y el reparto de motivos de Inicio y Métricas Sofía (6.5) | medio: los números cambian y se leen como un cambio real del negocio |
| Columnas nuevas en Supabase | agregar es seguro; un `CHECK` nuevo sin la migración correspondiente rechaza cada insert y **no deja rastro** si no se mira la respuesta — es el mes perdido del diagnóstico de atribución | **el peor caso ya ocurrido** |
| Las tres colas | una pregunta nueva que ninguna cola reconoce = paciente que se muere callada, el agujero que se cerró hoy mismo | **silencioso** |

---

## 6. Conflictos entre el flujo nuevo y el actual

### 6.1 ¿Las tres preguntas del tamizaje van hoy en un solo mensaje?

**No, y está prohibido explícitamente.** El prompt: *"de una en una, nunca las tres
en el mismo mensaje… un 'No' a tres preguntas juntas no dice a cuál contestó"*. El
clasificador tiene la regla gemela en código (`:4329`): si se preguntaron juntas y
la paciente contestó "no", las tres van `null`, porque un dato clínico inventado es
peor que uno ausente.

Consecuencia para 2.3.4 ("una pregunta por mensaje"): no es una regla nueva, es la
que ya existe. Y **"peso y estatura cuentan como una sola pregunta" la contradice**
en espíritu: son dos datos en un mensaje, con el mismo problema de atribución si la
paciente contesta un solo número.

### 6.2 ¿En qué momento entra hoy el tamizaje?

Exactamente donde el diseño quiere poner las preguntas nuevas: cuando la paciente
"ya mostró intención concreta de agendar". No es un hueco libre: las tres preguntas
actuales ya están ahí, y el prompt es explícito en que preguntar el precio no
habilita a empezar.

Entonces la v1 no agrega preguntas "después de" el tamizaje: **las mete en el mismo
cuello de botella**, en los 2 o 3 turnos entre "quiero agendar" y el traspaso.

### 6.3 El tope de 10 turnos — medido

`message_count` sube 1 por **mensaje de la paciente** (`:3860`), y el tope salta
cuando llega a 10 (`:1459`). De noche, con la atención nocturna encendida, el techo
es 20 (`:42`).

Medición sobre las 8.251 conversaciones con actividad entre el 2026-10-11 y hoy
(paginado completo, filtrado por `updated_at` y no por `created_at`):

| población | mediana | p90 | p95 | llegan a 10+ hoy | llegarían con 3 preguntas más |
|---|---|---|---|---|---|
| todas (8.251) | 3 | 8 | 9 | 5,0% | — |
| zonas del tamizaje (2.721) | 4 | 9 | 11 | 8,5% | **23,5%** |
| con el tamizaje contestado (942) | 6 | 10 | 12 | 15,8% | **43,4%** |

Leído en simple: en la población general sobra lugar, pero **en la población a la
que apunta este flujo, no**. De las pacientes que de verdad llegaron a contestar el
tamizaje, hoy 1 de cada 6 toca el tope; con tres preguntas más serían 2 de cada 5.
Y tocar el tope no es inocuo: fuerza el traspaso con el motivo `límite de mensajes
alcanzado`, que el dashboard clasifica como "Cierre del sistema" y la cola de
Seguimiento puntúa como mecánico, no como paciente que pidió una cita.

Son 7 cierres por tope al mes hoy con ese motivo; el salto no es de volumen, es de
en quién cae: justo las conversaciones más avanzadas.

### 6.4 `MOTIVO_URGENTE` y el prefijo propuesto

`MOTIVO_URGENTE` (`:135`) es una expresión regular sobre el **texto** del motivo.
Tres cosas:

1. **`urgente:` funcionaría** — la palabra "urgente" ya está en la lista.
2. **`médico:` no activa nada** y está bien que no lo haga: el estado B no es una
   urgencia.
3. **La lista ya incluye `molest[ao]`**. O sea que el caso 7 de las pruebas
   ("se molesta por las preguntas") hoy se clasifica como urgente si esa palabra
   aparece en el motivo: nunca se difiere de noche y se transfiere al instante.
   Puede estar bien, pero hay que saberlo, no descubrirlo.

Y la divergencia que sí es un problema: **"urgente" se define en dos lugares
distintos y no dicen lo mismo.** La vista `sofia_followup_queue` marca
`urgente = true` con otra regla que **no** incluye `dolor`, `fiebre`, `síntoma`,
`post-operatorio` ni `urgente`. Un traspaso que el Worker trata como urgentísimo
puede aparecer en Seguimiento sin la marca de urgente.

### 6.5 Qué espera hoy el dashboard de `escalation_reason`

Son **cuatro** consumidores del mismo texto libre:

1. `cecmarketing/src/constants/motivos.js` — seis expresiones regulares **en orden**,
   con `sin_motivo` como resto. El archivo dice, con todas las letras, que **tiene un
   gemelo en SQL** (`sofia_home_stats`) y que si se toca uno hay que tocar el otro;
   la comprobación es el reparto de octubre (1.310 / 193 / 166 / 156 / 152 / 11 / 4).
2. `sofia_home_stats` — el gemelo SQL, para Inicio.
3. La vista `sofia_followup_queue` — de ahí salen `categoria`, `urgente` y el
   **`score`** con el que se ordena la cola: `agendar|cita|valoraci|reservar|
   disponibilidad|horario` vale 40, `frase de traspaso` vale 40, y
   `precio|costo|cuánto|tarifa` vale 6.
4. `SeguimientoSection.jsx` — el buscador busca dentro de ese texto.

Dos consecuencias para la propuesta 2.5:

- Un motivo nuevo que no contenga ninguna de esas palabras **puntúa cerca de cero** y
  cae al fondo de la cola. Un traspaso médico de la v1 llamado `médico: antecedente
  quirúrgico complejo` queda debajo de cualquiera que haya dicho "cita".
- El prefijo **por sí solo no reclasifica nada**: `médico: …` no calza con ninguna
  de las seis reglas de `motivos.js`, así que esos traspasos irían a "Sin motivo
  claro" o, si el texto conserva la palabra "agendar", a "Solicitó una valoración".
  Para que el dashboard agrupe por tipo hay que tocar los tres gemelos —
  `motivos.js`, `sofia_home_stats` y la vista — y 2.8 dice que en la v1 el
  dashboard no se toca. **Es una contradicción del alcance y hay que resolverla
  antes de implementar**: o el prefijo espera a la v2, o la v1 incluye los tres
  gemelos.

Nota de método: el DDL vivo de la vista y de la función no se pudo leer desde acá
(solo `GET` por REST). Lo de arriba sale de las migraciones del repo más las
columnas reales de la vista, que coinciden con la última migración
(`20261105123000`). Pero ya pasó una vez que la vista viva no era la del repo, así
que **antes de escribir SQL sobre la cola hay que comparar contra el DDL vivo**.

### 6.6 La tercera cola no vería las preguntas nuevas

Lo que se desplegó hoy (`48365fa`, `1870bb1`) cubre dos formas de dejar algo
pendiente: Sofía ofreció coordinar, o Sofía preguntó el tamizaje. La segunda se
detecta con `PREGUNTAS_DEL_TAMIZAJE` (`:2328`), cuatro expresiones regulares
atadas a las tres preguntas actuales ("está embarazada", "planes de…",
"lactancia", "proceso activo de pérdida o aumento de peso"), y además se exige que
el mensaje **termine** en pregunta.

Si Sofía pregunta "¿cuánto pesa y cuánto mide?" y la paciente no vuelve, **ninguna
de las tres colas lo ve**: no escaló, no prometió nada, no ofreció coordinar y no
preguntó el tamizaje. Se muere sola. Es el mismo agujero que se midió en 130
conversaciones al mes y se cerró hoy, reabierto por la puerta de al lado.

Si la v1 agrega preguntas, **tiene que agregarlas a esa lista en el mismo commit**.

### 6.6b La marca de la tercera cola se queda pegada (revisión del 2026-11-10, 17:30)

Encontrado revisando la salud de lo que se desplegó hoy, no en la auditoría.

El barrido `escalarOfrecimientosSinRespuesta()` (`:4952`) filtra por
`escalated=is.false`, con razón: si el caso ya escaló por otro camino, ya tiene
dueño. Pero entonces **la marca de esa fila nunca se limpia**, porque lo único que
la borra es `limpiarOfrecimientoSinRespuesta()`, que corre desde el barrido o
cuando la paciente vuelve a escribir — y después de escalar, Sofía está muda.

Caso vivo de hoy: una conversación de rinoplastia con 11 mensajes, marcada a las
18:33 UTC, escalada después por el tope de mensajes, y a las 23:30 UTC seguía
marcada. Es 1 de 6 marcas vivas.

No hace daño hoy: la guarda impide el traspaso doble y nadie cuenta esas marcas.
Lo que deja es una columna que no se puede contar, y este trabajo pensaba
apoyarse en ella. El arreglo es una línea: limpiar la marca en los caminos que
escalan por otro motivo, igual que ya se limpian `traspaso_pendiente_desde` y
`escalacion_espera_desde` (`:1577`, `:2070`).

### 6.7 El clasificador se saltea a partir del tercer mensaje

Esto es lo más importante de la sección 2.6 del diseño y no está en el planteo.

`processInboundMessage()` (`:2029`) no reclasifica cuando
`messageCount >= 2` y ya hay un procedimiento concreto guardado: se ahorra el 38,8%
de las llamadas a Haiku (~$13/mes). En esos turnos devuelve `SIN_TAMIZAJE` y
`upsertConversation()` conserva lo que ya había.

O sea que **los campos nuevos del clasificador se calcularían solo en los dos
primeros mensajes de la conversación** — y el flujo clínico ocurre en el sexto o el
octavo. Tal como está, `preclasificacion`, `imc_orientativo` y `alertas` saldrían
`null` casi siempre.

Hay tres salidas y las tres cuestan algo: no saltear cuando el tamizaje o la
preclasificación estén incompletos (plata), clasificar la preclasificación en una
llamada propia (más plata y más latencia), o extraerla del texto por código y no
con el modelo (menos flexible). Es una decisión para la Parte 2, no un detalle de
implementación.

Y el efecto secundario ya conocido: ese atajo **congela el sentimiento**. Si la
paciente se molesta en el turno 5 —el caso 7 de las pruebas— hoy no queda
registrado.

### 6.8 La red del precio diferido y las preguntas clínicas

`difiereAlEquipo()` (`:2380`) escala cuando Sofía difiere un dato al equipo. Si una
pregunta clínica nueva la lleva a escribir "eso lo confirma el equipo médico", puede
disparar un traspaso con el motivo `difirió el precio al equipo sin etiqueta
[ESCALAR]` — un motivo falso para lo que pasó. Hay que revisar esa lista contra las
frases nuevas.

### 6.9 Escalar dejando una pregunta colgando

`esperar` (`:1923`) aplaza el traspaso un turno cuando el mensaje que escala
**termina en pregunta**, para que la paciente pueda contestar. Está medido: 16% de
las escalaciones terminaban preguntando algo, y en la red de promesas era el 83%.

Con tres preguntas clínicas más, ese camino se va a usar mucho más. No está roto
—es justamente la red que corresponde— pero cambia el perfil: más conversaciones
pasan por `escalacion_espera_desde`, que cuatro pantallas del dashboard cuentan
como "escaló".

### 6.10 La lista vacía no vuelve inerte al flujo

2.2 dice que la lista de procedimientos empieza vacía y 2.4 que entonces todo cae
en A o B. Eso es cierto para la **clasificación**, pero no para la
**conversación**: las preguntas nuevas, el momento en que entran y los turnos que
consumen no dependen de que haya criterios aprobados. Lo que no se puede probar sin
criterios es justamente la parte barata; lo riesgoso —el interrogatorio— ya estaría
vivo.

Si la lista arranca vacía, lo coherente es que **el bloque del prompt tampoco se
inyecte** mientras esté vacía. Hay que decirlo explícitamente en el diseño.

---

## 7. Lo que queda para que JP decida antes de la Parte 2

1. ~~Subir los 5 commits del Worker.~~ Ya estaban subidos; ver la corrección de la
   sección 0. No hay nada pendiente acá.
2. **El choque de 1.1**: el prompt prohíbe hoy, con nombre y apellido, reformular
   preguntas clínicas donde el tamizaje no aplica. Las preguntas nuevas son
   exactamente eso. Hay que decidir si el bloque nuevo limita su alcance a las mismas
   zonas del tamizaje actual, o si la prohibición se reescribe — y reescribirla toca
   una regla que se puso por un caso medido.
3. **El prefijo en `escalation_reason` (6.5)**: o espera a la v2, o la v1 incluye
   `motivos.js`, `sofia_home_stats` y la vista de la cola. Como está planteado
   —prefijo sin tocar el dashboard— los traspasos médicos caen al fondo de
   Seguimiento.
4. **El tope de 10 (6.3)**: con tres preguntas más, el 43,4% de las pacientes que
   contestan el tamizaje tocaría el tope. Opciones: menos preguntas, que las
   preguntas clínicas no cuenten para el tope, o subir el tope para esa rama. No se
   toca nada sin aprobación.
5. **Cuándo se calcula la preclasificación (6.7)**, dado que el clasificador se
   saltea desde el tercer mensaje.
6. **Si los criterios se respaldan** como el prompt en `sofia_config_backups`.

---

## Apéndice — cómo se midió

- Prompt y configuración: `GET /rest/v1/sofia_config` con la llave de servicio de
  `cecmarketing/.env.local`. Solo lectura, nada escrito.
- Turnos (6.3): `GET /rest/v1/sofia_conversations` filtrado por
  `updated_at >= 2026-10-11`, paginado de 1.000 en 1.000 hasta agotar (8.251 filas).
  El primer intento quedó topado en 1.000 filas por el límite de PostgREST y se
  descartó. "Zonas del tamizaje" se aproxima con una expresión regular sobre
  `procedure_interest` + `escalation_reason`
  (`abdominoplast|mamari|senos|mastopex|lipo|glute|brazo|muslo|cintura|contorno|preserv`):
  es la misma aproximación que usa la vista de la cola, y como toda aproximación por
  nombre tiene falsos positivos.
- Tercera cola viva: conteo exacto con `Prefer: count=exact` sobre
  `ofrecimiento_sin_respuesta_desde`.
- Código: `src/index.js` en `feature/preclasificacion` (= `main` = `origin/main`, `1870bb1`).
