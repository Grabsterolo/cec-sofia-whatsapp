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

### 1.5f Vuelta a asignación puntual — round-robin entre los 4 asesores (reemplaza 1.5c)

El escalar al grupo completo (1.5c) hacía que las conversaciones se
amontonaran de forma pareja en el pool compartido, sin repartirse. JP pidió
que Zenvia distribuya el trabajo asignando cada escalación a un asesor
específico, rotando entre los 4 en orden fijo.

`transferProspectToGroup()` se eliminó; ahora `transferToNextAgentInPool()`
llama a `transferProspectToAgent()` (`as-user/transfer`, la misma que ya se
usaba para que Sofía se auto-asignara) con el siguiente `agentId` de
`HUMAN_AGENTS` en orden: Adrian → Angie → Ingrid → Jordan → Adrian → ...

El turno se guarda en `sofia_config.escalation_round_robin_index` (columna
nueva, entero que solo crece — el agente es `index % 4`, así que no hay que
manejar el "dar la vuelta" como caso especial). Es un read-then-write
simple contra Supabase, no atómico: si dos escalaciones llegaran en el
mismo instante exacto podrían leer el mismo índice y caer en el mismo
asesor. Aceptado a propósito — las escalaciones son poco frecuentes, así
que el riesgo real de que eso pase es bajísimo, y el costo de un turno
salteado ocasional es bajo.

**Verificación:** con `wrangler dev --remote` + una ruta de debug temporal,
6 llamadas seguidas a `pickNextPoolAgent()` devolvieron exactamente
`Adrian, Angie, Ingrid, Jordan, Adrian, Angie` (confirmado el orden
correcto y el wraparound), y `escalation_round_robin_index` en Supabase
subió de 0 a 6. Después, una llamada a `transferToNextAgentInPool()` con
un `prospectId` falso disparó `transferProspectToAgent()` de verdad contra
Zenvia (confirmado en el log: `transferProspectToAgent failed 404` — el
404 esperado para un prospecto falso, no un error de scope/auth).

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
10 mensajes), **antes de transferir al siguiente asesor del pool** (ver
1.5f), `runEscalationAgility()` en
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

### 1.9 Resuelto el trade-off de 1.8 — Sofía vuelve a responder cuando Zenvia marca la conversación como "closed"

El fix de 1.8 dejó un trade-off aceptado a la fuerza: una vez `escalated =
true` para un `phone_hash`, Sofía nunca volvía a responder, sin importar si
el asesor humano ya había resuelto y cerrado el caso. En la práctica esto se
notó como "Sofía dejó de responder" en conversaciones que en realidad ya
estaban resueltas del lado humano.

**La señal que faltaba:** el objeto `prospect` de Zenvia (`GET
/prospect/{id}`) trae un campo `status` con 4 valores reales documentados por
Zenvia — `new`, `processing`, `followUp`, `closed` — que solo cambia cuando
alguien realmente cierra la conversación. A diferencia de `Interaction.id`
(que cambia en cada mensaje individual, ver 1.7/1.8), `status` es estable
mientras la conversación sigue abierta.

**Fix:** cuando `conversationState.escalated` es `true`, en vez de detenerse
siempre, ahora se consulta `getProspectStatus()` (`GET /prospect/{id}`):
- Si `status !== "closed"` (o falla la consulta) → se mantiene el
  comportamiento de 1.8: silencio total, sin tocar nada.
- Si `status === "closed"` → se trata como una conversación nueva: se
  resetea `escalated = false` y `message_count = 0` (vía el parámetro
  `resetCounters` en `upsertConversation`, reintroducido pero ahora atado a
  una señal confiable en vez del `Interaction.id`) y Sofía responde
  normalmente.

Importante: esto **no toca** el gate de "humano ya asignado" (1.8) — ese
sigue siendo incondicional y se evalúa antes que nada, sin importar el
`status` del prospecto.

**Verificación:** probado con `wrangler dev --remote` + `prospectId` falso y
tres conversaciones pre-cargadas en Supabase con `escalated = true`: (a)
`status` no-cerrado (lookup a un ID falso → 404 → `null`) → se mantuvo en
silencio, cero cambios en la fila; (b) `status === "closed"` (simulado con un
override local temporal, revertido antes del commit) → Sofía respondió y la
fila quedó con `escalated = false`, `message_count = 1`; (c) `agentId` de un
humano real + `status === "closed"` → el gate de humano bloqueó igual, sin
siquiera llegar a consultar el status.

**Corrección post-deploy — el valor real es `"archived"`, no `"closed"`:**
el artículo de ayuda de Zenvia usa nombres genéricos ("Closed") que no
coinciden con el valor literal que la API devuelve. Confirmado en vivo con
`GET /prospects?group={groupId}&limit=5000` sobre el grupo real (`620bdb7d...`,
5000 resultados, tope de la API): los únicos valores de `status` observados
son `"new"`, `"unclaimed"`, `"followUp"` y `"archived"` — nunca `"closed"`.
Un prospecto real archivado (`status: "archived"`, con `archivingReason`
poblado) lo confirmó. El código se corrigió para comparar contra
`"archived"` en vez de `"closed"` (mismo día del deploy original, antes de
que causara ningún problema real — el bug era "silencioso": con `"closed"`
el resume simplemente nunca se disparaba, pero tampoco reactivaba a Sofía
de forma incorrecta). Re-verificado con el mismo método de tres casos
(fake ID no-archivado, override local `"archived"`, humano + archived) —
mismos resultados.

### 1.10 Sofía también responde Facebook Messenger, no solo WhatsApp

`GET /messaging/channels` confirma que esta cuenta tiene conectados
**whatsapp** y **facebook** (`channelId: "880573125292638"`) — no hay
Instagram conectado todavía. El topic `interactions` al que ya estábamos
suscritos (ver 1.3) ya entregaba eventos de ambos canales — el Worker
simplemente los descartaba: `extractInboundFromInteraction()` filtraba con
`interaction.via !== "whatsApp"`.

**Cambio:** `SUPPORTED_CHANNELS` (`src/index.js`) mapea cada `via` que
Zenvia manda a la cadena que `messaging/{channel}` espera para responder
(`whatsApp` → `whatsapp`; `facebook` → `facebook`, ya coincide). El
`channel` resuelto viaja junto con el mensaje entrante por todo
`processInboundMessage()` y se usa para:
- `sendWhatsappMessage()` → renombrada a `sendChannelMessage(env, prospectId, channel, content)`,
  llama `messaging/{channel}` en vez de tener `whatsapp` fijo.
- `sofia_whatsapp_sessions.channel` y `sofia_conversations.channel` — ya
  no se hardcodea `"whatsapp"` al insertar, se guarda el canal real.

**No cambia:** el resto de la lógica (RAG, Claude, escalación, pool
round-robin, gates de seguridad) es channel-agnostic y sigue igual —
solo dependía de `prospectId`/`agentId`/`phone` (que para Facebook en
realidad es el PSID del usuario, no un número real, pero funciona igual
como identificador único para el hash de sesión).

**Limitación conocida:** el modo `"warn"` (dormido) de la limpieza por
inactividad (`sendWarnings()`) sigue asumiendo WhatsApp siempre —
`getOpenProspects()` no trae el canal de cada prospecto. No es un problema
activo porque el botón del dashboard usa `mode: "closeDirect"` (no manda
mensajes), pero habría que resolverlo antes de reactivar el modo `"warn"`
si para entonces ya hay conversaciones de Facebook stale de verdad.

**Verificación:** `wrangler dev --remote` + dos webhooks fabricados con
`prospectId` falso — uno con `via: "facebook"` (sender un PSID falso) y
uno con `via: "whatsApp"` (regresión). Ambos se procesaron completos: RAG
+ Claude respondieron coherentemente, `sendChannelMessage failed facebook
404` / `sendChannelMessage failed whatsapp 404` confirmaron que cada uno
llamó al endpoint de `messaging/{channel}` correcto (404 esperado por
prospectId falso, no error de canal/formato), y Supabase guardó
`channel: "facebook"` correctamente en `sofia_conversations` y
`sofia_whatsapp_sessions` para el caso de Facebook.

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
       verdad — el transfer al asesor del pool (ver 1.5f) no necesariamente
       lo hace de inmediato, así que este chequeo cubre ese hueco mientras la
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
     bloquea), transfiere al siguiente asesor del pool (ver 1.5f) y guarda
     `escalated: true`,
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
     al **siguiente asesor del pool** (round-robin, ver 1.5f).
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

### `POST /cleanup/scan-and-warn` — limpieza de buzón por inactividad

Protegido por header `x-cleanup-secret` (debe coincidir con el secret
`CLEANUP_TRIGGER_SECRET`). Body: `{ "dryRun": true|false }` (default `true`
si se omite — un run real requiere pasar `dryRun: false` explícitamente).

**Investigación previa (corrige varios supuestos del spec original):**
- `prospect.status` real (confirmado vía `GET /prospects?group=...&limit=5000`
  sobre el grupo real): `new`, `unclaimed`, `followUp`, `archived` — no
  `new`/`processing`/`followUp`/`closed` como sugiere el artículo de ayuda de
  Zenvia (ver también la corrección en 1.9 más arriba).
- `archivingReason "inactive"` ("Inactivo") ya existe en
  `GET /as-user/archiving-reasons` — no hubo que crear ninguno.
- No existe `agent.nextReminder` ni `interaction.dueAt` en los datos reales
  de esta cuenta (revisados 100 prospects) — el resguardo de "saltar si
  tiene recordatorio pendiente" del spec original se omitió, por indicación
  explícita, en vez de construirse contra un campo que no existe.
- `GET /prospects` tiene un tope duro de `limit=5000` y **no** soporta
  `offset`/`page`/`cursor`. Filtrar server-side por `status=followUp` y
  `status=unclaimed` (las únicas conversaciones abiertas) mantiene el
  conteo muy por debajo de ese tope (~925 al momento de escribir esto)
  sin necesitar paginación.
- `GET /prospects/interactions` no soporta `group` ni `prospectId` como
  filtros, pero `createdAfter` sí funciona sin requerir `agent` — permite
  traer toda la actividad reciente de la cuenta en una sola llamada
  (~4800/5000 en una ventana de 24h al momento de escribir esto — cerca del
  tope, revisar si el tráfico crece) y cruzarla contra la lista de
  conversaciones abiertas para encontrar cuáles llevan ≥24h sin actividad.

**Lógica:**
1. `getOpenProspects()` — conversaciones con `status=followUp` o
   `status=unclaimed` en el grupo del CEC.
2. `getRecentlyActiveProspectIds()` — ids con al menos una interacción en
   las últimas 24h, cuenta completa. Si falla, aborta sin avisar ni cerrar
   nada (fail closed).
3. `stale = open - recentlyActive`. Se excluyen los que ya están en
   `sofia_inactivity_cleanup` con `closed_at IS NULL` (ya avisados,
   pendientes del cierre automático — no se re-avisan).
4. Si `dryRun`: solo devuelve el resumen, cero mensajes, cero escrituras.
5. Si no: manda `INACTIVITY_WARNING_MESSAGE` por WhatsApp a cada uno y
   guarda `warned_at = now()` en `sofia_inactivity_cleanup`.

El mensaje de aviso (`INACTIVITY_WARNING_MESSAGE` en `src/index.js`) es un
copy propio, cálido y formal ("usted"), sin emojis — mismo tono que
`sofia_config.system_prompt`, aunque este flujo no pasa por Claude.

### `scheduled()` — cron de cierre (cada 30 min, ver `wrangler.toml`)

1. Lee `sofia_inactivity_cleanup` con `closed_at IS NULL` y
   `warned_at <= now() - 2h`.
2. Revisa actividad desde el `warned_at` más antiguo del lote (una sola
   llamada a `getRecentlyActiveProspectIds`, reusada para todo el lote).
3. Si el prospecto tuvo actividad desde que se le avisó: `skipped_reason =
   "respondió"` y se marca `closed_at = now()` igual (para sacarlo de la
   cola — si vuelve a quedar inactivo, un futuro `scan-and-warn` lo detecta
   de nuevo con un `warned_at` fresco; dejarlo con `closed_at = null`
   indefinidamente lo haría revisarse en cada cron para siempre).
4. Si no: `POST /prospect/{id}/as-user/archive` con
   `archivingReason: "inactive"` y `closed_at = now()`.

**Verificación:** `dryRun: true` corrido contra el grupo real (925
conversaciones abiertas, 512 inactivas ≥24h detectadas, cero mensajes/
escrituras). El cierre (`scheduled()`) se probó con dos filas falsas
insertadas directo en Supabase (sin pasar por Zenvia, mismo prospectId
inválido de siempre): una con `warned_at` de hace 3h → correctamente
archivada (`404` esperado contra el prospectId falso) y marcada
`closed_at`; otra con `warned_at` de hace 30 min → correctamente ignorada
(no vencía todavía). La rama "respondió" no se probó en vivo contra un
prospecto real (para no arriesgar archivar una conversación real por
error durante la prueba) — la lógica es simétrica a la ya validada en
1.9/1.8 (`Set.has()` sobre ids reales), pero queda pendiente de una
verificación en vivo si se quiere esa confianza extra antes de confiar en
ella a ciegas.

### Incidente en producción — timeout en el envío real + cambio a cierre directo sin WhatsApp

El primer intento real (`dryRun: false`) desde el botón del dashboard
falló: mandaba los 535 avisos uno por uno, esperado cada uno de forma
síncrona dentro del mismo request HTTP interactivo (dashboard → Pages
Function → este Worker). Eso tarda minutos — mucho más de lo que esa
cadena de peticiones aguanta abierta — así que la conexión se cortó a
mitad de camino. El navegador recibió la página de error HTML de la
plataforma en vez de JSON (`Unexpected token '<'... is not valid JSON`).

**Efecto real:** antes de cortarse, alcanzó a mandar el mensaje de aviso a
**23 conversaciones reales** (confirmado por sus filas en
`sofia_inactivity_cleanup` con `warned_at` entre 20:00:45 y 20:00:54 UTC
del 2026-07-27). Esas 23 quedaron correctamente registradas y las cierra
el cron normal 2h después si nadie responde — no hubo que hacer nada
especial con ellas.

**Fix — envío en segundo plano:** `sendWarnings()` (el loop que manda los
avisos) ahora se dispara con `ctx.waitUntil()` en vez de esperarse en
línea. El endpoint responde de inmediato con un resumen ("N en cola") y
el envío real sigue corriendo en segundo plano después de que la
respuesta ya salió — sin este cambio, cualquier tanda de más de ~30-50
mensajes reventaría el mismo timeout. Verificado con `wrangler dev
--remote` + una ruta de debug temporal: 20 IDs falsos encolados, la
respuesta volvió en ~490ms, y los 20 envíos de fondo se completaron poco
después (cada uno con el error esperado por ser un ObjectId inválido, sin
detener el lote).

**Cambio de alcance — `mode: "closeDirect"`:** después de ver que ese
primer intento real ya había costado 23 mensajes de WhatsApp reales, JP
pidió no seguir pagando por avisar una por una a las ~500 restantes, sino
cerrar directamente las conversaciones inactivas ≥24h sin mandarles nada.
`POST /cleanup/scan-and-warn` ahora acepta `{ dryRun, mode }`:
- `mode: "warn"` (default) — el flujo original: manda el aviso por
  WhatsApp, cierra 2h después si no hay respuesta (`sendWarnings()`).
- `mode: "closeDirect"` — nuevo: llama `POST /prospect/{id}/as-user/archive`
  directamente para cada conversación stale, sin enviar ningún mensaje
  (`closeDirectly()`). Solo marca la fila como `closed_at` si el archive en
  Zenvia realmente respondió `ok` — si falla, se deja sin cerrar para que
  un `scan-and-warn` futuro la vuelva a intentar.

El botón del dashboard (`SofiaConversationsSection.jsx`) ahora manda
siempre `mode: "closeDirect"` — ya no ofrece la opción de avisar por
WhatsApp desde la UI (el código de `mode: "warn"` se deja en el Worker por
si se necesita reactivarlo más adelante, pero nada en el dashboard lo
dispara).

Verificado con `wrangler dev --remote`: `dryRun` con `mode: "closeDirect"`
contra el grupo real (941 abiertas, 527 stale) — mismos números que antes,
cero escrituras. El envío real de `closeDirectly()` se probó igual que
`sendWarnings()`, con 5 prospectIds falsos vía una ruta de debug temporal:
respuesta en ~550ms, los 5 archivados en segundo plano fallaron de forma
segura (`400 Invalid prospectId`, ObjectId inválido esperado) sin
detenerse entre sí.

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

Necesaria para el botón de limpieza de inactividad del dashboard
(`POST /cleanup/scan-and-warn`) — debe tener el mismo valor que el secret
`CLEANUP_TRIGGER_SECRET` del proyecto de Cloudflare Pages `sofiacec`
(`functions/api/cleanup-scan.js` en `cecmarketing`):

```bash
wrangler secret put CLEANUP_TRIGGER_SECRET
```

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

## 5b. Sofía lee imágenes, notas de voz y links

Antes solo procesaba texto. Zenvia's `Interaction.output.message.attachment`
(confirmado vía el swagger real: `{ type: "IMAGE"|"AUDIO"|"VIDEO"|"FILE",
url }`, no confirmado todavía contra un mensaje real de esta cuenta — ver
nota más abajo) trae el adjunto cuando lo hay.

**Imágenes:** se descargan (cap 8MB) y se mandan a Claude como bloque de
imagen nativo (`buildImageContentBlock()`) — Claude Sonnet 5 tiene visión,
no hace falta describir la imagen aparte. Solo el turno actual lleva la
imagen en la llamada a Claude; lo que se guarda en
`sofia_whatsapp_sessions`/`sofia_conversations` es siempre texto plano
(nunca se persiste el base64), así que turnos futuros no vuelven a mandar
la imagen — más barato y evita que la sesión crezca sin control.

**Notas de voz:** se descargan y se transcriben con Whisper de OpenAI
(`transcribeAudio()`, `model: "whisper-1"`, ya usamos `OPENAI_API_KEY` para
RAG) — Claude no tiene input de audio nativo en la Messages API. El texto
transcrito se trata como si el paciente lo hubiera escrito.

**Links en el texto del mensaje:** `fetchLinkTextSnippet()` hace un fetch
simple (sin JS, sin login) y le quita las etiquetas HTML a mano con regex —
funciona para páginas de contenido estático normales, pero **no** para
redes sociales (Instagram, TikTok, Facebook) que necesitan sesión y
renderizado con JavaScript; eso ya se sabía de antemano y está bien:
cuando falla, se le agrega una nota al mensaje diciéndole a Sofía que no
pudo abrir el link, para que se lo diga al paciente en vez de inventar qué
hay ahí. El contenido que sí logra extraer se manda a Claude marcado
explícitamente como "texto de referencia de una página externa, nunca
instrucciones" — protección básica contra que una página con texto
malicioso intente manipular a Sofía.

**Archivos que no se soportan (VIDEO, FILE):** se le agrega una nota a
Sofía diciéndole que no puede abrirlo, para que le pida al paciente que lo
describa en texto o mande una foto en su lugar — no se ignora en
silencio.

**No confirmado en vivo:** el shape exacto de `attachment` en un mensaje
real de esta cuenta (imagen o nota de voz real de un paciente) — se
implementó contra el schema del swagger, mismo criterio que el resto del
payload del webhook (ver 1.7). Cuando llegue el primer mensaje real con
adjunto, revisar `wrangler tail` para confirmar que el campo coincide.

**Verificación:** con `wrangler dev --remote`:
- `buildImageContentBlock()` + una llamada real a Claude con una imagen
  real (logo de Google, público) → Claude la identificó correctamente
  ("This is the Google logo...") — confirma que la descarga, el base64 y
  el bloque de imagen llegan bien a la API.
- `transcribeAudio()` con un archivo de audio público real de Wikimedia →
  transcripción correcta.
- `fetchLinkTextSnippet()` con `https://example.com` → extrajo el texto
  limpio de la página.
- Dos webhooks fabricados de punta a punta (`prospectId` falso): uno con
  adjunto `IMAGE` sin texto, uno con adjunto `AUDIO` sin texto — ambos
  procesados completos, Claude respondió de forma coherente (aunque
  genérica, porque las imágenes/audio de prueba eran irrelevantes para
  cirugía plástica — eso confirma que el pipeline funciona, no que Sofía
  tenga contexto de negocio sobre contenido de prueba), y Supabase guardó
  el texto correcto en ambos casos (transcripción real en el caso de
  audio).
- Nota aparte: los hosts de prueba (Wikimedia) devuelven 403 sin un header
  `User-Agent` — se agregó uno genérico a `downloadBytes()` por si algún
  otro host además de las URLs propias de Zenvia lo requiere alguna vez.

---

## 5c. Envío manual de mensaje de cumpleaños — `POST /send/birthday`

JP pidió poder mandarle a alguien un mensaje de cumpleaños por WhatsApp
apretando un botón en el dashboard de `cecmarketing` — no automático, no
disparado por cron, una persona decide cuándo.

**Por qué no reutiliza `sendChannelMessage()` (la que usa Sofía para
responder):** ese endpoint (`messaging/{channel}`, sin `/notification`)
solo funciona si el prospecto tiene conversación abierta o escribió por
WhatsApp en las últimas 24h (ventana estándar de WhatsApp Business, ver
1.4). Un mensaje de cumpleaños lo iniciamos nosotros, así que va a caer
fuera de esa ventana casi siempre. El endpoint correcto para eso es el
hermano mencionado en 1.4 y nunca antes usado:

```
POST /prospect/{prospectId}/messaging/{channel}/notification?api-key=...
Content-Type: application/json

{ "templateId": "...", "variables": {} }
```

(`variables` viaja vacío a propósito — la plantilla que JP creó no tiene
placeholder `{{1}}`, texto fijo igual para todos. Decisión explícita suya:
no vale la pena volver a someter la plantilla a revisión de Meta solo por
personalizar el nombre.)

(`operationId` no confirmado en vivo; schema `NewTemplateMessage` leído del
`swagger.json` real vía fetch — `{ templateId: string, variables: object }`
— scope `messages:transactional`. No requiere ventana de 24h porque manda
una plantilla de WhatsApp Business pre-aprobada por Meta, que es justamente
para esto.)

**Cómo se identifica al prospecto:** `sofia_conversations` en Supabase
guarda `phone_hash` (hash de un solo sentido, por privacidad), no el
teléfono en claro ni el `prospectId` — no sirve para esto. En vez de eso,
`POST /send/birthday` recibe el número de teléfono en claro (lo escribe la
persona en el dashboard) y lo resuelve a un prospecto con
`GET /prospect-by?phoneNumber=...` (confirmado presente en el
`swagger.json` real, no probado en vivo todavía).

**Body de la request:** `{ "phoneNumber": "..." }`.
Protegido con header `x-send-secret` == secret `SEND_TRIGGER_SECRET` (mismo
patrón que `CLEANUP_TRIGGER_SECRET`, ver `handleScanAndWarn`). El caller es
un endpoint de Cloudflare Pages Functions en `cecmarketing`
(`functions/api/send-birthday.js`) que el frontend del dashboard llama
directo — el secret nunca llega al navegador.

**Estado (2026-08-05): EN PRODUCCIÓN, probado en vivo con éxito.** Worker
desplegado, webhook de Zenvia registrado, plantilla "Cumpleaños" aprobada
por Meta (`key`/`BIRTHDAY_TEMPLATE_ID`: `74e35668-994e-4fb5-b891-063e578ede5b`,
sin placeholder — texto fijo, decisión de JP). Probado end-to-end contra un
número real (+50661130913) — envío exitoso, `200 ok`.

Dos bugs reales encontrados y corregidos durante la prueba en vivo, ninguno
visible solo leyendo el swagger:
1. **403 "Invalid scope... need messages:transactional"** incluso después
   de que JP agregó el scope a la API key en Zenvia y guardó — resultó ser
   caché de autorización del lado de Zenvia en ese endpoint específico
   (`GET /integration` ya reflejaba el scope nuevo, pero el endpoint de
   envío tardó ~15-20 min más en verlo). No es nada que arreglar en este
   repo, solo esperar si vuelve a pasar.
2. **400 SCHEMA_VALIDATION_FAILED: "must have required property 'key'"** —
   el body real de `NewTemplateMessage` es `{ key, parameters }`, no
   `{ templateId, variables }` como se había asumido de un resumen de IA
   del swagger.json (ver el fetch original en la sección de arriba, que
   quedó con el nombre de campo equivocado). Confirmado contra
   `GET /messaging/channels`, que expone el `key` real de cada plantilla —
   coincidía exactamente con el `BIRTHDAY_TEMPLATE_ID` que JP había dado.
   `sendTemplateMessage()` ya usa los nombres correctos.

**Después de un envío exitoso, el prospecto se transfiere a Sofía**
(`transferProspectToAgent(env, prospectId, SOFIA_AGENT_ID)`, mismo
mecanismo que ya usa `processInboundMessage()` para reclamar conversaciones
nuevas) — JP pidió que si la persona responde al mensaje de cumpleaños,
Sofía siga la conversación. Sin esto, un prospecto que ya había hablado con
CEC antes casi siempre tiene un agente humano asignado de esa conversación
previa, y el gate de "conversación de un humano, no tocar" en
`processInboundMessage()` la habría dejado en silencio. Best-effort: si la
transferencia falla, no se convierte el envío exitoso en un error de
respuesta — solo significa que la respuesta del paciente cae donde ya
estaba antes, como pasaba antes de este fix.

**No cubierto por este fix:** si ese mismo teléfono ya había escalado a un
humano *a través de Sofía* antes (`sofia_conversations.escalated=true` en
Supabase) y el `status` del prospecto en Zenvia no es `"archived"`, el gate
de "ya escalado" separado en `processInboundMessage()` sigue aplicando sin
importar quién sea el dueño actual — un mensaje de cumpleaños no lo
resetea. No se resolvió porque no está claro que deba (podría ser
intencional seguir sin tocar esas conversaciones).

Si más adelante se quiere personalizar el mensaje con el nombre, hay que
crear una nueva versión de la plantilla con `{{1}}`, volver a someterla a
Meta, y pasar `parameters: { "prospect.firstName": ... }` en vez de `{}`
(reintroduciendo un campo `name` en el body y en el formulario del
dashboard) — revisar el `key` real que Zenvia asigne al placeholder vía
`GET /messaging/channels` antes de asumir el nombre exacto.

---

## 5d. Fix: conversaciones sin escalar no quedaban etiquetadas en Zenvia

JP reportó que Sofía no está etiquetando las conversaciones. Causa: las
etiquetas de Zenvia (`addLabelToProspect()`, `POST
/prospect/{id}/as-user/label`) solo se aplicaban dentro de
`runEscalationAgility()`, llamada únicamente en la rama `if (escalated)` de
`processInboundMessage()` (y en el flujo de límite de mensajes, que también
escala). La rama `else` — donde Sofía resuelve la conversación por su
cuenta, que según el propio comentario del código es "la gran mayoría" de
los casos — llamaba a `classifyEscalationWithHaiku()` con una lista de
etiquetas vacía a propósito ("no hace falta etiqueta de Zenvia aquí"), así
que esas conversaciones sí quedaban con `procedure_interest`/`sentiment` en
Supabase, pero nunca con etiqueta en Zenvia.

**Fix:** la rama `else` ahora llama `getAvailableLabels()` y pasa la lista
real a `classifyEscalationWithHaiku()`, y aplica `addLabelToProspect()`
igual que la rama de escalación. Costo: una llamada más a Zenvia
(`getAvailableLabels`) y potencialmente otra (`addLabelToProspect`) por
cada turno no escalado — aceptable, mismo patrón que ya existía para
escalaciones.

---

## 5e. Cierre automático de conversaciones inactivas por cron

JP encontró 659 conversaciones abiertas en Zenvia, 407 de ellas inactivas
≥24h, y ninguna marcada "pending" — el botón manual de limpieza
("Cerrar conversaciones inactivas" en el dashboard, `mode: closeDirect`)
llevaba tiempo sin correrse. Causa raíz: cerrar conversaciones era 100%
manual. El cron que ya corría cada 30 min (`scheduled()`) solo ejecutaba
`closeInactiveConversations()` — fase 2 del flujo `warn` (cerrar lo que ya
fue advertido y no respondió) — pero nada usa el modo `warn` en la
práctica, así que ese cron era esencialmente un no-op.

**Fix:** `scheduled()` ahora también corre `scanAndWarn(env, ctx, {
dryRun: false, mode: "closeDirect" })` — la misma lógica que ya usaba el
botón del dashboard — cada 30 min. `CLEANUP_BATCH_LIMIT` (20 por corrida)
es de sobra para mantenerse al día una vez que el backlog existente se
vacíe (40/hora en estado estable). El backlog que ya existía cuando se
detectó el problema se vació aparte, corriendo el endpoint manualmente
varias veces (mismo mecanismo, solo que de una sola vez).

---

## 5f. Índice de conversión de Sofía — `GET /stats/conversion`

JP preguntó si hay forma de saber la tasa de conversión de Sofía. No
existía ningún dato cruzado para calcularla: `sofia_conversations` en
Supabase solo guardaba `phone_hash` (hash de un solo sentido, por
privacidad) — sin el `prospectId` real no hay forma de consultar en
Zenvia si ese prospecto terminó en venta.

**Cambios:**
- Columna nueva `sofia_conversations.prospect_id` (migración
  `add_prospect_id_to_sofia_conversations`, vía Supabase MCP) —
  `upsertConversation()` ahora la guarda en cada turno. Solo aplica hacia
  adelante desde 2026-08-05; las ~2920 filas anteriores no se pueden
  backfillear (el hash no es reversible).
- `GET /stats/conversion` (header `x-stats-secret` ==
  `STATS_TRIGGER_SECRET`): junta los `prospect_id` distintos de
  `sofia_conversations` (opcionalmente filtrados por `?since=` ISO date),
  trae todos los prospectos archivados del grupo
  (`fetchProspectsByStatus(..., "archived")`, mismo helper que ya usa la
  limpieza) y cruza cada `prospect_id` contra su `archivingReason`.
  "Convertido" = `archivingReason` en `converted` ("Venta") o
  `campaignConversion` ("Venta de campaña") — confirmado en vivo vía
  `GET /as-user/archiving-reasons`.
- El dashboard (`cecmarketing`) lo muestra en Inicio, tarjeta "Conversión
  de Sofía" — `functions/api/conversion-stats.js` hace de proxy (mismo
  patrón que `send-birthday.js`, secret nunca llega al navegador).

**Limitación real:** el número solo va a tener sentido después de que se
acumulen suficientes conversaciones nuevas — el día que se implementó
esto arrancó en `0/0`. No es retroactivo.

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
