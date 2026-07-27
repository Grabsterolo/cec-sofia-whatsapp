# cec-sofia-whatsapp

Cloudflare Worker que conecta a **Sofía** (agente de IA del Centro Europeo de
Cirugía, definido en Supabase) con **WhatsApp** a través de **Zenvia
Conversion** (el producto antes conocido como Sirena).

Repo de referencia para el patrón de RAG + prompt caching:
[Grabsterolo/cecmarketing](https://github.com/Grabsterolo/cecmarketing),
en particular `functions/api/chat.js`.

## ⚠️ Estado: listo para revisión, NO desplegado

Este repo está listo para que el usuario:
1. Revise el código y este README.
2. Corra `wrangler deploy` manualmente.
3. Registre la suscripción al webhook (`POST /notifications/subscriptions`)
   como último paso, una vez el Worker esté desplegado y la URL sea estable.

No se hizo deploy ni se registró ningún webhook durante el desarrollo.

---

## 1. Lo que se descubrió sobre la API real de Zenvia Conversion

Esta sección documenta la exploración en vivo hecha con la API key nueva
(permisos: Webhooks, Read + Write Endpoints, Mensajes Conversacionales,
Actuar en nombre de un usuario — usuario "WhatsApp Bot" al momento de la
exploración inicial). Todas las llamadas de exploración fueron **GET** (de
solo lectura); no se modificó ni se envió ningún mensaje real a través de la
cuenta de producción del CEC durante esta investigación.

> **Cambio de identidad (2026-07-30):** el "Actuar como" de la integración
> se cambió en Zenvia de "WhatsApp Bot" a un asesor real llamado
> **"Sofia CEC"** (`6a65946e85b682f18c9d3dd7`). El código usa ese ID
> (constante `SOFIA_AGENT_ID` en `src/index.js`); los ejemplos de esta
> sección que mencionan "WhatsApp Bot" con el ID viejo
> (`624353d6ed44c7429615e36e`) documentan cómo se descubrió el mecanismo, no
> el estado actual — la forma de la API no cambió, solo qué agente es.

### 1.1 Producto y dominio

- El producto es efectivamente **Sirena**, adquirido por **Zenvia** y
  renombrado **"Zenvia Conversion"**.
- Los dominios históricos (`api.getsirena.com`, `api.sirena.app`,
  `help.sirena.app`) **ya no resuelven** (NXDOMAIN confirmado con dos
  resolvers DNS-over-HTTPS independientes: Cloudflare `1.1.1.1` y Google
  `8.8.8.8`). No es un problema de red local — el dominio fue dado de baja.
- **El dominio vigente es `https://conversion.zenvia.com`.** Confirmado en
  vivo:
  - `GET https://conversion.zenvia.com/v1/notifications/topics?api-key=...` → `200`
  - `GET https://conversion.zenvia.com/swagger.json` → `200`, devuelve el
    spec OpenAPI 3 completo y actual (`info.version: "1.10.0"`,
    `info.title: "Zenvia Conversion API"`).
  - El propio spec trae `servers: [{ "url": "/v1" }]`, es decir, base real
    **`https://conversion.zenvia.com/v1`**. (El campo legado `host` dentro
    del spec todavía dice `api.getsirena.com` — es metadata vieja que no
    refleja el dominio servido; no usarlo.)

> Si en el futuro esto vuelve a cambiar, `https://conversion.zenvia.com/swagger.json`
> es la fuente de verdad — bajarlo y revisar `paths` de nuevo.

### 1.2 Autenticación

API key como query string param `api-key` en cada request:

```
GET https://conversion.zenvia.com/v1/prospect/{prospectId}?api-key=YOUR_API_KEY
```

(También existe un esquema `PrivateToken` vía header `X-API-Token`, no usado aquí.)

### 1.3 `GET /notifications/topics` (resultado real)

```json
[
  { "name": "prospects", "description": "To get notified of changes on one of your prospects, or when a new prospect is created." },
  { "name": "interactions", "description": "Events related to existing or new interactions are notified in this topic" },
  { "name": "quotes", "description": "Events related to existing or new quotes are notified in this topic" },
  { "name": "agents", "description": "Events related to agents" }
]
```

Para este bot nos interesa el topic **`interactions`**.

### 1.4 Endpoint para enviar un mensaje de respuesta

```
POST /prospect/{prospectId}/messaging/{channel}?api-key=...
Content-Type: application/json

{ "content": "texto del mensaje" }
```

- `operationId: sendMessage`, tag "Conversational Messaging", scope
  `messages:conversational` (ya habilitado en la key).
- `{channel}` = `"whatsapp"` (confirmado con `GET /messaging/channels`, que
  devuelve el canal de WhatsApp del CEC con `channelId: "50689768814"` — ese
  es el número de WhatsApp del CEC, no un valor a mandar en la URL).
- Solo funciona si el prospect tiene conversación abierta o escribió por
  WhatsApp en las últimas 24h (ventana estándar de WhatsApp Business).
- Hermanos que **no** se usan aquí pero existen: `.../messaging/{channel}/notification`
  (mensaje transaccional con template pre-aprobado) y `.../messaging/{channel}/send-file`.

### 1.5 Endpoint para reasignar a un agente humano

Hay dos variantes de transferencia:

```
POST /prospect/{prospectId}/transfer?api-key=...
{ "group": "<groupId>" }              // transferir a un grupo, scope prospects:read
```

```
POST /prospect/{prospectId}/as-user/transfer?api-key=...
{ "user": "<agentId>" }               // transferir a un usuario/agente puntual
```

Usamos la segunda: `as-user/transfer`, `operationId: transferProspectAsUser`,
scope `integration:act-as-user` — **este es exactamente el permiso "Actuar en
nombre de un usuario"** que ya está habilitado en la key, configurado sobre
el usuario "WhatsApp Bot". Confirmado en vivo con `GET /integration`:

```json
{ "...", "providerKey": "...integration:act-as-user", "user": "624353d6ed44c7429615e36e" }
```

`624353d6ed44c7429615e36e` es el agente "WhatsApp Bot 🤖" — coincide con lo
que describiste. Si la key no tuviera usuario configurado, este endpoint
devuelve `409`.

### 1.5b Notas internas al escalar — confirmado en vivo, implementado

```
POST /prospect/{prospectId}/interactions
{ "type": "note", "content": "texto de la nota" }
```

(`operationId: createInteractionByProspectId`, body `NewEvent` → una de sus
variantes es `NewNoteEvent: { type: "note", content: string }`.)

**Funciona.** El intento inicial contra un `prospectId` inventado daba un
`404` con cuerpo vacío — distinto a la forma de 404 (JSON con mensaje) del
resto de endpoints — lo cual generaba dudas razonables. Con autorización
explícita del usuario se creó un prospect de prueba real y desechable
(`POST /lead/retail`, nombre "Test Borrar / Cec-sofia-whatsapp", sin
teléfono, solo email inválido de prueba) y se repitió la prueba contra su
`prospectId` real:

```
POST /prospect/6a65925a.../interactions
{ "type": "note", "content": "prueba" }

→ 200 OK
[{
  "id": "6a65926244a7bb9e01d1716e",
  "status": "created",
  "output": { "comment": "prueba" },
  "via": "other"
}]
```

Es decir: el `404` anterior era específicamente por el `prospectId` falso
(el servidor valida su formato/existencia de forma distinta a los otros
endpoints antes de llegar al error estándar), no porque la ruta no exista.
Con un prospect real responde `200`, crea una interacción nueva, y el texto
de la nota queda en `output.comment` (no en `output.note.content` — el
campo de salida no refleja 1:1 el nombre del campo de entrada).

**Implementado.** `addEscalationNote()` en `src/index.js` llama a este
endpoint justo antes de transferir, con `escalation_reason` + los últimos 2
mensajes de la conversación (paciente y Sofía) como contexto. Probado
end-to-end contra el mismo prospect de prueba forzando una escalación real
(síntomas de emergencia post-operatoria): la nota quedó registrada con el
motivo y la transcripción, y la transferencia posterior a un agente humano
(Adrian Ureña) también se confirmó — el prospect pasó de `status: unclaimed`
a `status: followUp` con `agent` asignado. El prospect de prueba se borró
(`DELETE /prospect/{id}`) al terminar.

### 1.6 Descubrir a quién transferir

- `GET /agents?group=<groupId>` y `GET /as-user/transfer` devuelven la lista
  de agentes disponibles para transferir. En vivo, para el grupo
  "Centro Europeo de Cirugia" (`620bdb7ddc95c70003482762`):

  | Nombre | id |
  |---|---|
  | Adrian Ureña | `65fdf6b1d40c421938223798` |
  | Angie Barboza | `6244ca9a8dcc736594aa3f28` |
  | Ingrid Calderón | `6447ff23812154a143050118` |
  | Jordan Murillo | `620bdb7ddc95c7000348276c` |
  | WhatsApp Bot 🤖 (viejo, ya no se usa) | `624353d6ed44c7429615e36e` |
  | Sofia CEC (identidad actual de la IA, no usar como destino de escalación) | `6a65946e85b682f18c9d3dd7` |

- `GET /group/{groupId}/agents/online` existe y devuelve quién está
  conectado ahora mismo (`{"agents":[...], "officeHours": true}`) —
  **ya no se usa**. La escalación dejó de elegir un agente humano
  específico (ver 1.5c) y ahora transfiere directo al grupo, así que
  `pickAgentForEscalation()` se eliminó del código.

### 1.5c Escalación al grupo, no a un agente específico

Al escalar, el Worker ya no elige un agente humano puntual — transfiere el
prospect al grupo completo con `POST /prospect/{prospectId}/transfer`
(`{ "group": "620bdb7ddc95c70003482762" }`, scope `prospects:read`,
confirmado contra el `swagger.json` real). Cualquiera del equipo que esté
disponible lo puede tomar desde el pool del grupo — ya no hace falta la
lógica de "elegir quién está online" que existía antes.

### 1.5d Investigación — ¿marcar "no leído" y/o etiquetas? (solo lectura del spec, nada implementado)

Investigación puntual pedida para evaluar dos ideas antes de decidir si se
integran. **Nada de esto está en el código todavía.**

#### ¿"No leído" al transferir? — no existe, no hay nada parecido

Búsqueda exhaustiva en el `swagger.json` real por `unread`, `read`, `seen`,
`viewed`, `pending`, `flag` en nombres de campo y descripciones. **No existe
ningún campo, endpoint o mecanismo para marcar un prospect/interaction como
"no leído" o "pendiente de revisar".** El único uso de "read" en todo el
spec es el scope `prospects:read` y el status `"read"` dentro del enum de
estado de **entrega** de un mensaje de WhatsApp
(`pending, sent, received, read, failed, deleted` — eso es si el paciente
leyó el mensaje, no si el agente humano revisó la conversación).

Dos mecanismos **adyacentes** que sí existen y podrían servir como
alternativa, sin ser lo mismo que lo pedido:

1. **`ProspectStatus`** (`unclaimed | new | followUp | processing |
   archived`, ver `Prospect.status` en el spec) — cambia solo con las
   transferencias/reclamos que ya hacemos. Confirmado en vivo en la prueba
   de la ronda anterior: al transferir a un agente humano, el prospect pasó
   de `unclaimed` a `followUp` con `agent` asignado. Es plausible que esto
   ya sea lo que hace que la conversación se vea "pendiente" en el panel de
   Zenvia — no confirmado visualmente, habría que revisar el panel.
2. **`POST /apps/notifications`** (`operationId: sendNotification`, scope
   `notifications`) — manda una notificación push real al panel/app de
   Zenvia, dirigida a un usuario puntual o a un rol (`owner | agent |
   admin`), en Android/iOS/desktop:
   ```
   POST /apps/notifications?api-key=...
   {
     "type": "string (libre)",
     "target": { "user": ["<agentId>", ...] } // o { "role": ["agent"] }
     "platforms": { "android": {...}, "ios": {...}, "desktop": {...} }
   }
   ```
   El spec deja `android`/`ios`/`desktop` como objetos completamente
   abiertos, sin propiedades documentadas — no hay forma de confirmar el
   formato exacto del contenido solo leyendo el spec.

   **⚠️ Probado en vivo (con autorización explícita, `target.user` con un
   ObjectId inexistente — mismo truco que con los prospects de prueba, no
   le llegó nada a nadie real) y actualmente no funciona, sin importar el
   payload:**
   ```
   400 { "code": "UNEXPECTED_ERROR", "message": "This app does not have the
   permissions to send notifications", "summary": "ValidationError" }
   ```
   Esto **no es un error de formato** — es un permiso a nivel de la
   integración/app en Zenvia, distinto del scope `notifications` de la API
   key (que es el que usa la suscripción a webhooks, una función totalmente
   distinta que coincide de nombre por casualidad). Para que esto funcione
   de verdad, la integración del CEC necesitaría estar registrada como
   "Custom App" con permiso de notificaciones desde el panel de Zenvia —
   eso no se puede hacer por API, es una acción manual del lado de Zenvia.
   Mientras tanto, cualquier llamada a este endpoint va a fallar siempre
   con el mismo 400, así que si se integra debe ser estrictamente
   best-effort (ver 1.5e).

#### ¿Etiquetas/tags sobre un prospect? — sí existe, y sí es de escritura

```
POST /prospect/{prospectId}/as-user/label?api-key=...
{ "label": "<key de una etiqueta existente>" }

→ 200, devuelve el Prospect actualizado
```

- `operationId: labelProspect`, scope `integration:act-as-user` (ya
  habilitado en la key, mismo scope que usamos para reclamar/transferir).
- El valor de `label` no es texto libre — tiene que ser el `key` de una
  etiqueta ya configurada en la cuenta. Para verla:
  ```
  GET /as-user/labels?api-key=...
  → [{ "key": "cold", "name": "Frío" }, { "key": "hot", "name": "Caliente" }, ...]
  ```
  Se confirmó en vivo (llamada de solo lectura, sin tocar ningún prospect)
  — la cuenta del CEC tiene **77 etiquetas configuradas**, casi todas de
  interés/procedimiento para marketing y seguimiento comercial. **No hay
  ninguna etiqueta existente con semántica de "pendiente de revisar" o
  similar** — si se quisiera usar esto para eso, habría que pedirle al
  equipo que cree una etiqueta nueva (ej. "Revisar — Sofía") desde el panel
  de Zenvia, porque las etiquetas no se crean por API, solo se **aplican**
  las que ya existen (no se encontró un `POST` para crear/gestionar
  etiquetas, solo `GET /as-user/labels` para listarlas y `POST .../label`
  para aplicar una a un prospect puntual).

  <details>
  <summary>Lista completa de las 77 etiquetas (key → nombre), capturada 2026-07-26</summary>

  | key | nombre |
  |---|---|
  | cold | Frío |
  | warm | Tibio |
  | hot | Caliente |
  | bodytite | Bodytite |
  | morpheus | Morpheus |
  | valoracionSenosDrChacon | Valoración Senos (Dr. Chacon) |
  | valoracionSenosDrSolis | Valoración Senos (Dr. Solis) |
  | valoracionCorporal | Valoración Corporal |
  | toxinaBotulinica | Toxina Botulínica |
  | valoracionRinoplastia | Valoración Rinoplastia |
  | radiesse | Radiesse |
  | valoracionDraMilenaJimenez | Valoración Dras |
  | carboxiterapia | Carboxiterapia |
  | oxyGeneo | OxyGeneo |
  | masajePostCirugia | Masaje Post Cirugía |
  | bodyFx | Body FX |
  | depilacion | Depilación |
  | controlDrSolis | Control Dr. Solis |
  | controlDrChacon | Control Dr. Chacon |
  | peelingFacial | Peeling Facial |
  | otoplastia | Otoplastia |
  | precio | Precio |
  | valoracionFacialDrChacon | Valoracion lifting |
  | redensity1 | Redensity 1 |
  | redensity2 | Redensity 2 |
  | valoracionDrJeffrySolis | Valoracion Dr. Jeffry Solis |
  | valoracionDeSenos | Valoracion de Senos |
  | rellenos | Rellenos |
  | cosmelan | Cosmelan |
  | accutite | Accutite |
  | mesoxeomin | Mesoxeomin |
  | facetite | Facetite |
  | correo | Correo |
  | valoracionConEsteticista | Valoracion con Esteticista |
  | tratamientosFaciales | Tratamientos Faciales |
  | formaV | Forma V |
  | dermatologia | Dermatología |
  | drHerrera | Dr. Herrera |
  | trilipo | Trilipo |
  | trifraccional | Trifraccional |
  | mesoterapia | Mesoterapia |
  | co2 | Co2 |
  | voluderm | Voluderm |
  | pinkIntimate | Pink Intimate |
  | enzimas | Enzimas |
  | datosIncorrectos | Datos Incorrectos |
  | plasmage | Plasmage |
  | dermamelan | Dermamelan |
  | presoterapia | Presoterapia |
  | blefaroplastia | Blefaroplastia |
  | controlDrHerrera | Control Dr. Herrera |
  | controlDrJeffrySolis | Control Dr. Jeffry Solis |
  | nutricion | Nutrición |
  | mia | MIA |
  | laserPicoSegundo | Láser pico segundo |
  | hydrafacial | Hydrafacial |
  | plasmaRicoEnPlaquetas | Plasma rico en plaquetas |
  | radiofrecuenciaFacial | Radiofrecuencia facial |
  | dermapen | Dermapen |
  | controlPostCosmelan | Control post cosmelan |
  | controlDraMonge | Control Dra Monge |
  | lobuloplastia | Lobuloplastia |
  | ultrasonido | Ultrasonido |
  | best | BEST |
  | labioplastia | Labioplastia |
  | infoGeneral | Info general |
  | lipomas | Lipomas |
  | nutricionista | Nutricionista |
  | harmony | Harmonyca |
  | celluma | Celluma |
  | nctf | NCTF |
  | liftera | Liftera |
  | exosomas | Exosomas |
  | sueroterapia | Sueroterapia |
  | peptidos | Péptidos |
  | ultherapy | Ultherapy |
  | naturalLift | Natural lift |

  Esta lista puede cambiar con el tiempo (el equipo la administra desde el
  panel de Zenvia) — el Worker **no** usa esta tabla estática, siempre
  llama a `GET /as-user/labels` en vivo antes de clasificar (ver 1.5e), así
  que queda automáticamente al día.
  </details>

Modelos legacy `Category`/`CategoriesByIndustry` (del client PHP viejo,
ver sección 1 más arriba): en el spec actual solo sobrevive `Category`
(`Prospect.category`, un string de solo lectura sobre el prospect —
"unique name identifier of the prospect category", ligado a la creación
del lead vía `POST /lead/*`, no algo que se pueda cambiar después vía API
sobre un prospect existente) y `GET /leads/categories` (categorías
disponibles para creación de leads, no para etiquetar prospects ya
existentes). `CategoriesByIndustry` ya no aparece en el spec actual.

### 1.5e Agilidad para asesores al escalar — implementado

Cuando `escalated` es `true` (por `[ESCALAR]` de Sofía o por el límite de
10 mensajes), **antes de transferir al grupo**, `runEscalationAgility()` en
`src/index.js` corre tres pasos, todos **best-effort** — ninguno puede
bloquear ni retrasar lo importante (responder al paciente, transferir):

1. **Clasificación con Haiku** (`claude-haiku-4-5`, no Sonnet — es
   clasificación simple, no conversación): le pasa el historial completo
   de la conversación y la lista de etiquetas reales (`GET
   /as-user/labels` en vivo, no la tabla estática de arriba) y le pide un
   JSON con `label` (el `key` exacto de una etiqueta, o `null`),
   `procedure_interest` (resumen corto) y `sentiment`
   (`positivo`/`neutral`/`negativo`). El `label` que devuelva se valida
   contra la lista real antes de usarlo — si Haiku inventa un key que no
   existe, se trata como `null`.
2. Si `label` no es `null`: `POST /prospect/{id}/as-user/label` con esa
   key (confirmado funcional, ver 1.5d).
3. `POST /apps/notifications` (ver 1.5d) — **actualmente siempre falla**
   con 400 por el permiso de "Custom App" no habilitado en Zenvia. Se deja
   la llamada igual porque es best-effort y no cuesta nada que falle; va a
   empezar a funcionar sola en cuanto se habilite el permiso del lado de
   Zenvia, sin tocar código.

`procedure_interest` y `sentiment` que devuelve Haiku se guardan en
`sofia_conversations` en el mismo `upsert` final, junto con `escalated` y
`escalation_reason`.

**Bug encontrado y arreglado durante las pruebas:** Haiku a veces envuelve
el JSON en un fence de markdown (` ```json ... ``` `) pese a que el prompt
le pide no hacerlo — `classifyEscalationWithHaiku()` le quita el fence
antes de parsear.

**Bug real detectado en producción y corregido (2026-07-27):** un lead que
llegó por un anuncio de Meta sobre Radiesse escaló con
`procedure_interest: "Ultherapy"` — Sofía había mencionado Radiesse,
Morpheus8 y Ultherapy como opciones durante la conversación, y el
clasificador agarró una sin relación clara con el interés real de origen
del paciente. Fix: el prompt ahora separa explícitamente el **primer
mensaje del paciente** en la conversación (la señal más confiable de
interés de origen, y donde suele aparecer contexto de anuncio si Zenvia lo
adjunta, ej. "Source: Meta - ID:...") del resto del historial, y el system
prompt agrega una regla de priorización explícita: usar lo que el paciente
pidió originalmente, nunca una opción que Sofía solo haya mencionado entre
varias sin que el paciente la confirmara — y preferir una etiqueta más
general (o `null`) antes que adivinar. Reproducido y confirmado en una
prueba con una conversación sembrada (primer mensaje sobre Radiesse desde
un anuncio, Sofía ofreciendo Radiesse/Morpheus8/Ultherapy sin que el
paciente confirmara ninguna, escalación por solicitud de agendar):
`procedure_interest` quedó como `"Radiesse, contorno facial"` — el interés
real de origen, no una de las opciones mencionadas de pasada.

Probado con `wrangler dev --remote` + `prospectId` falso, forzando ambos
caminos de escalación (por `[ESCALAR]` y por límite de mensajes): en
ambos, el flujo llegó completo hasta `transferProspectToGroup` pese a que
etiquetado y notificación fallaron con 404/400 esperados (ID falso /
permiso no habilitado), y Haiku devolvió clasificaciones sensatas
(ej. `sentiment: "negativo"` para un mensaje de emergencia post-operatoria,
`procedure_interest: "Botox"` para una pregunta sobre Botox) que quedaron
guardadas correctamente en Supabase.

### 1.7 Forma del payload del webhook (⚠️ no confirmada al 100%)

Zenvia **no publica** el schema del payload que empuja a la `callback_url`
(el spec OpenAPI solo documenta la API que tú llamás, no lo que ellos te
mandan). Lo que sí pudimos confirmar en vivo es la forma del recurso
`Interaction` que la API expone (via `GET /prospect/{id}/interactions`), que
es casi con certeza la misma forma que se empuja para el topic
`interactions`, dado que ambos usan el mismo modelo `Interaction` en el spec:

```json
{
  "id": "6a658060c930190705a333a6",
  "createdAt": "2026-07-26T03:34:56.694Z",
  "status": "created",
  "prospectId": "6a6580609c84c803a923289e",
  "agentId": "624353d6ed44c7429615e36e",
  "agent": { "id": "...", "firstName": "WhatsApp", "lastName": "Bot 🤖", ... },
  "via": "whatsApp",
  "output": {
    "message": {
      "via": "whatsApp",
      "body": "Hola. ¿Puedo obtener más información sobre esto?",
      "content": "Hola. ¿Puedo obtener más información sobre esto?",
      "performer": "integration",
      "sender": "+50683326684",
      "recipient": "50689768814",
      "delivered": false
    }
  }
}
```

`performer: "integration"` = mensaje entrante del paciente.
`performer: "agent"` = saliente (nuestro propio bot u otro agente) — **nunca
hay que responderle a esto**, o se genera un loop.

Lo que **no sabemos con certeza** es el sobre (envelope) con el que Zenvia
empaqueta este objeto al hacer el POST al webhook: puede venir como el
objeto crudo, como `{ "topic": "interactions", "data": {...} }`, como un
array, etc. Por eso `extractInboundMessages()` en `src/index.js` es
deliberadamente tolerante: acepta objeto suelto, array, o envuelto en
`data`/`interaction`, y filtra por `output.message.performer === "integration"`
y `via === "whatsApp"` en cualquier caso.

**Antes de dar esto por bueno en producción:** cuando registres la
suscripción (paso 3 más abajo) y llegue el primer mensaje real, revisa
`wrangler tail` — si `extractInboundMessages` no encuentra nada, el
`console.error`/log de la request cruda te va a decir exactamente qué forma
tiene el sobre real, y hay que ajustar esa función (no el resto del Worker).

### 1.8 Bug crítico en producción — Sofía se reasignaba conversaciones ya tomadas por un humano (corregido)

**Síntoma real:** un prospecto ("Anita 🌸", `prospectId`
`6a65117e44a7bb9e01ac3e40`) ya había sido tomado por Jordan Murillo, y Sofía
se lo reasignó a sí misma y le siguió respondiendo al paciente.

**Causa raíz:** la lógica de "conversación nueva/reabierta" (agregada en 1.6,
sección "reset on new interaction") comparaba `interactionId !==
conversationState.lastInteractionId` para decidir si aplicar los dos gates de
seguridad (humano ya asignado, conversación ya escalada) o saltárselos por
tratarse de terreno "fresco". La premisa era que Zenvia reutiliza un mismo
`Interaction.id` por hilo de conversación y solo emite uno nuevo al reabrir un
hilo cerrado. Esa premisa era falsa: confirmado en vivo (ver 1.7,
`GET /prospect/{id}/interactions`), Zenvia emite un `Interaction.id` distinto
**por cada mensaje individual**, no por hilo. Eso hacía que
`isNewConversation` fuera casi siempre `true`, lo cual:

- Saltaba el gate de "ya lo tiene un humano" en casi todos los mensajes.
- Saltaba el gate de "ya está escalada" en casi todos los mensajes.
- Rompía el límite de 10 mensajes: `resetCounters: isNewConversation` casi
  siempre `true` significaba que `message_count` nunca acumulaba más de 1.

**Fix aplicado:** se eliminó por completo `isNewConversation` /
`resetCounters` / `effectiveMessageCount`. Los dos gates de seguridad y la
acumulación de `message_count` ahora son incondicionales en cada mensaje —
ya no dependen de comparar `Interaction.id` para nada.

**Trade-off aceptado explícitamente:** una vez que `escalated = true` para un
`phone_hash`, Sofía ya no vuelve a responderle automáticamente a ese
paciente, incluso si genuinamente reabre la conversación semanas después —
no existe hoy una señal confiable de Zenvia para distinguir "mismo hilo
abierto, mensaje nuevo" de "hilo genuinamente reabierto". Se prefirió este
silencio-por-defecto sobre el riesgo de repetir el incidente de
Sofía-reemplazando-a-un-humano. Para reactivar a Sofía en una conversación
puntual hay que limpiar manualmente `escalated = false` en
`sofia_conversations` (Supabase).

**Verificación:** probado con `wrangler dev --remote` + `prospectId` falso,
simulando (a) primer mensaje entrante con `agentId` de un humano real ya
asignado → confirmado que el Worker no responde ni reclama; (b) un segundo
mensaje del mismo prospecto/teléfono con un `interactionId` **distinto**
(reproduciendo exactamente el disparador del bug real) → también bloqueado
correctamente, cero filas escritas en Supabase; (c) flujo normal sin
`agentId` asignado → sigue funcionando sin cambios.

---

## 2. Qué hace el Worker

`src/index.js`, un solo endpoint:

### `POST /webhook`

1. (Opcional) valida `?secret=` contra `WEBHOOK_SHARED_SECRET` si está seteada
   — Zenvia no firma sus webhooks, así que esta es la única protección
   disponible aparte de mantener la URL secreta.
2. Parsea el body defensivamente (ver 1.7) y extrae mensajes entrantes de
   WhatsApp.
3. Por cada mensaje:
   - **Interruptor de emergencia:** lee `sofia_config.whatsapp_enabled`
     (boolean, default `true` — toggle "Sofía al aire / Sofía en pausa" en
     el dashboard de `cecmarketing`, sección Configurar a Sofía). Si es
     `false`, se ignora el mensaje por completo antes de cualquier otra
     cosa — ni respuesta, ni reclamo, ni escritura en Supabase, solo un
     `console.log`. Es la primera revisión de todo el flujo.
   - Hashea el teléfono con SHA-256 → `phone_hash` y consulta
     `sofia_conversations` (`message_count`, `escalated`,
     `last_interaction_id`) para ese hash en una sola llamada
     (`getConversationState()`).
   - **¿Conversación nueva o reabierta?** Zenvia asigna un `interactionId`
     nuevo cada vez que una conversación cerrada se reabre (o de entrada,
     en un contacto nuevo, donde no hay `last_interaction_id` guardado
     todavía). Esa es la señal real de "esto es territorio nuevo para
     Sofía" — no `message_count` ni `escalated` por sí solos, porque esos
     campos pueden venir de una ronda anterior ya cerrada. Si el
     `interactionId` entrante es distinto al `last_interaction_id`
     guardado (`isNewConversation`), se saltan por completo los dos
     chequeos de abajo y se procesa como si fuera la primera vez —
     `message_count` efectivo arranca en 0 para esta corrida, y el
     `upsert` final resetea `escalated: false` (más lo que decida Sofía en
     este turno) y reemplaza `message_count`/`last_interaction_id` con los
     valores frescos.
   - Si **no** es una conversación nueva (mismo `interactionId` que la vez
     pasada), aplican los dos chequeos existentes, en orden:
     - **Si un humano ya tiene la conversación** (`agentId` de la
       interacción coincide con Adrian, Angie, Ingrid o Jordan): se ignora
       por completo — sin responder, sin reclamar, sin tocar
       `sofia_conversations`, solo un `console.log` breve.
     - **Freno definitivo por conversación ya escalada:** si `escalated`
       ya es `true` (por decisión de Sofía con `[ESCALAR]` o por haber
       llegado antes al límite de turnos, dentro de esta misma
       conversación abierta), se ignora el mensaje por completo — sin RAG,
       sin Claude, sin reclamo, sin respuesta, solo un `console.log`. No
       depende de que Zenvia ya haya reasignado `agentId` a un humano de
       verdad — el transfer al grupo (ver 1.5c) no necesariamente lo hace
       de inmediato, así que este chequeo cubre ese hueco mientras la
       conversación siga con el mismo `interactionId`.
   - Reclama la conversación como Sofia CEC (`POST
     /prospect/{id}/as-user/transfer` con `user` = `SOFIA_AGENT_ID`) apenas
     llega, salvo que la interacción ya venga asignada a Sofia CEC — así no
     queda mezclada en el pool "Sin asignar" de Zenvia mientras Sofía la
     atiende. Se lanza en paralelo con el resto del procesamiento, no
     bloquea. Solo se llega a este punto cuando sí vamos a procesar el
     mensaje — ambos chequeos de arriba cortan el flujo antes si aplican.
   - Lee/crea la sesión en `sofia_whatsapp_sessions` (upsert por
     `phone_hash`, que sí tiene constraint único).
   - Agrega el mensaje del paciente al historial, recorta a los últimos
     20 mensajes (~10 turnos) antes de mandarlo a Claude.
   - **Límite de 10 turnos:** si el `message_count` efectivo (0 si es
     conversación nueva, el valor guardado si no) es `>= 10`, **no llama a
     Claude** — manda uno de 3 mensajes fijos elegido al azar
     (`pickMessageLimitReply()`, tono cálido: "Quiero asegurarme de que le
     den la mejor ayuda posible con esto...", etc. — ver
     `MESSAGE_LIMIT_REPLIES` en `src/index.js`), corre la agilidad para
     asesores (`runEscalationAgility()`, ver 1.5e — best-effort, nunca
     bloquea), transfiere al grupo (ver 1.5c) y guarda `escalated: true`,
     `escalation_reason: "límite de mensajes alcanzado"` +
     `procedure_interest`/`sentiment` de lo que devolvió Haiku. Corta el
     flujo ahí — y de paso activa el freno del punto anterior para el
     resto de esta conversación (mientras siga con el mismo
     `interactionId`).
   - Carga `sofia_config` (system_prompt + knowledge_base) desde Supabase.
   - RAG: embedding con `text-embedding-3-small` de los últimos 2 mensajes
     del usuario → `match_sofia_chunks` (top 6, threshold 0.5) → si no hay
     chunks, cae a mandar el `knowledge_base` completo. Mismo patrón que
     `chat.js`, incluyendo qué bloques llevan `cache_control: ephemeral`.
   - Agrega un bloque final de sistema con la fecha/hora actual en Costa
     Rica (offset fijo UTC-6, sin horario de verano — `formatCostaRicaDateTime()`
     en `src/index.js`), **sin** `cache_control` y siempre al final, después
     de los bloques cacheados — si fuera antes invalidaría el caché en cada
     mensaje. El `system_prompt` en Supabase tiene una regla de saludo
     ("Buenos días" / "Buenas tardes" / "Buenas noches") que depende de esto;
     sin este bloque Claude no tiene forma de saber la hora real y saludaba
     mal (confirmado en producción: "buenas tardes" de noche).
   - Llama a Claude (`claude-sonnet-5`, `max_tokens: 1024`,
     `thinking: {type: "disabled"}`, prompt caching habilitado).
   - Parsea `[ESCALAR: motivo]` de la respuesta (mismo regex tolerante que
     el fix en `chat.js`), lo remueve del texto.
   - Guarda el historial actualizado en `sofia_whatsapp_sessions`.
   - Si **no** escala: responde al paciente vía
     `POST /prospect/{id}/messaging/whatsapp`.
   - Si **sí** escala: primero adjunta una nota interna con
     `escalation_reason` + los últimos 2 mensajes vía
     `POST /prospect/{id}/interactions` (ver 1.5b), después manda la
     respuesta de Sofía (que ya trae la frase de transición antes del tag
     `[ESCALAR]`) al paciente vía `messaging/whatsapp` — salvo que quede
     vacía, en cuyo caso se salta ese envío —, corre la agilidad para
     asesores (`runEscalationAgility()`, ver 1.5e) y por último transfiere
     al **grupo** (ver 1.5c), no a un agente específico.
   - Actualiza `sofia_conversations` (insert si no existe fila para ese
     `phone_hash`, update si ya existe — la tabla no tiene constraint único
     en `phone_hash`, así que es lectura+escritura manual, no un upsert de
     PostgREST): `last_message`, `escalated`, `escalation_reason`,
     `last_interaction_id` (siempre se actualiza al `interactionId`
     entrante), y `message_count` — que suma +1 sobre el valor guardado en
     conversaciones normales, o arranca de 0+1 si `isNewConversation` era
     `true` (`resetCounters` en `upsertConversation()`). También guarda
     `procedure_interest` y `sentiment` — `null` salvo que se haya
     escalado en este turno (ver 1.5e).
4. Responde `200` a Zenvia siempre que el body haya parseado como JSON
   (incluso si el procesamiento downstream falló para algún mensaje) —
   evita que Zenvia reintente y duplique respuestas al paciente. Los errores
   quedan en logs (`console.error`, visibles con `wrangler tail`).

### `GET /health`

Health check trivial (`200 ok`) para verificar que el Worker está arriba.

---

## 3. Variables de entorno necesarias

Ninguna está en el código ni en `wrangler.toml`. Configúralas manualmente:

```bash
wrangler secret put ZENVIA_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

Opcional (recomendada, ver 1.7 — Zenvia no firma webhooks):

```bash
wrangler secret put WEBHOOK_SHARED_SECRET
```

Si la seteas, la `callback_url` que registres en el paso 5 debe incluir
`?secret=<el mismo valor>`.

---

## 4. Deploy (manual, pendiente)

```bash
npm install
wrangler deploy
```

Después de desplegar, `wrangler tail` es la forma más rápida de ver qué
está pasando en vivo (incluyendo el payload crudo del primer webhook real,
crítico para confirmar 1.7).

---

## 5. Registrar el webhook (último paso, manual)

**No se hizo todavía.** Una vez el Worker esté desplegado y tengas la URL
final (`https://cec-sofia-whatsapp.<subdominio>.workers.dev/webhook`, o un
dominio custom):

```bash
curl -X POST "https://conversion.zenvia.com/v1/notifications/subscriptions?api-key=$ZENVIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topics": ["interactions"],
    "callbackUrl": "https://cec-sofia-whatsapp.<subdominio>.workers.dev/webhook?secret=<WEBHOOK_SHARED_SECRET si la configuraste>"
  }'
```

Nota: "las suscripciones están limitadas a una por grupo, y suscribirse dos
veces desactiva la primera" (texto literal del spec) — si ya existe una
suscripción de otra integración sobre este mismo grupo, este POST la va a
reemplazar. Revisa `GET /notifications/subscriptions?api-key=...` antes de
registrar para ver si ya hay algo activo (al momento de esta exploración,
la respuesta era `[]` — no había ninguna suscripción activa).

---

## 6. Cosas a tener en cuenta / próximos pasos

- **El group ID, los IDs de agentes y el channel de WhatsApp están
  hardcodeados** en `src/index.js` (no son secretos, son config específica
  del CEC en Zenvia). Si cambian los agentes del equipo o se agrega alguno
  nuevo, hay que actualizar el array `HUMAN_AGENTS` a mano.
- El round robin de escalación es un placeholder simple (preferir online,
  si no elegir al azar) — no hay memoria entre requests porque los Workers
  son stateless por request. Si el volumen lo justifica, la mejora natural
  es un contador en Workers KV o una columna en Supabase.
- La cuenta de Zenvia del CEC **ya tiene tráfico real de WhatsApp
  entrando** (se vio en la exploración) — cualquier prueba de este Worker en
  producción va a interactuar con esa cuenta real. Recomendado probar
  primero con `wrangler dev` + un payload de prueba armado a mano antes de
  registrar el webhook de verdad.
- Reevaluar el modelo `claude-sonnet-5` antes del 2026-08-31 (fin del precio
  promocional mencionado).
