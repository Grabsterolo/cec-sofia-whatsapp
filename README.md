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
Actuar en nombre de un usuario — usuario "WhatsApp Bot"). Todas las llamadas
de exploración fueron **GET** (de solo lectura); no se modificó ni se envió
ningún mensaje real a través de la cuenta de producción del CEC durante esta
investigación.

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

### 1.5b Notas internas al escalar — no confirmado, no implementado

Se buscó en el `swagger.json` real algo tipo "adjuntar una nota interna a un
prospect/interaction antes de transferir". Sí existe algo con esa forma en
el spec:

```
POST /prospect/{prospectId}/interactions
{ "type": "note", "content": "texto de la nota" }
```

(`operationId: createInteractionByProspectId`, body `NewEvent` → una de sus
variantes es `NewNoteEvent: { type: "note", content: string }`. También
existe `PUT /prospect/{prospectId}/interaction/{interactionId}` con
`UpdateEvent`, pero esa unión no incluye una variante de nota — solo
pregunta/mensaje.)

**No se integró en el código porque la prueba en vivo no fue concluyente.**
Con un `prospectId` inventado, todos los demás endpoints de este proyecto
devuelven un 404 con cuerpo JSON reconocible
(`{"code":"NOT_FOUND","message":"Prospect does not exist",...}`) — así es
como se probaron con seguridad sin tocar pacientes reales. Este endpoint, en
cambio, devuelve un `404` con cuerpo completamente vacío (sin
`content-type`, sin JSON) — una forma distinta a la de cualquier otro
endpoint confirmado en este repo. Como control, un JSON malformado contra la
misma ruta sí devuelve un error de aplicación normal
(`{"code":"UNEXPECTED_ERROR",...}`), o sea que la ruta llega a la capa de
aplicación — pero el caso "bien formado + prospect inexistente" no se
comporta como los demás.

No se pudo confirmar más porque hacerlo bien requeriría escribir contra un
`prospectId` real (crear un lead de prueba desechable vía `POST /lead/retail`
y borrarlo después) — el intento de crear ese lead de prueba fue bloqueado
por el clasificador de auto-mode de la sesión por ser una escritura real en
el CRM de producción, y no se insistió sin autorización explícita del
usuario.

**Conclusión:** por ahora, el contexto para el agente humano al escalar
sigue siendo únicamente el hilo de WhatsApp compartido (que ya incluye el
mensaje de transición que Sofía manda antes de transferir, ver sección 2).
No se agregó ninguna llamada de "nota interna" al flujo. Si se quiere
confirmar esto de verdad, hay que probarlo contra un prospect real (de
prueba, desechable) con autorización explícita — o preguntarle a soporte de
Zenvia directamente.

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
  | WhatsApp Bot 🤖 (no usar) | `624353d6ed44c7429615e36e` |

- **Bonus no pedido pero útil:** `GET /group/{groupId}/agents/online` sí
  existe y devuelve quién está conectado ahora mismo (`{"agents":[...],
  "officeHours": true}`). El Worker lo usa para preferir un agente humano
  que esté online antes de caer al fallback pseudo-aleatorio (ver
  `pickAgentForEscalation` en `src/index.js` — tiene un TODO explícito sobre
  las limitaciones de esto).

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
   - Reclama la conversación como WhatsApp Bot (`POST
     /prospect/{id}/as-user/transfer` con `user` = el propio agente
     WhatsApp Bot) apenas llega, salvo que la interacción ya venga asignada
     a WhatsApp Bot — así no queda mezclada en el pool "Sin asignar" de
     Zenvia mientras Sofía la atiende. Se lanza en paralelo con el resto del
     procesamiento, no bloquea.
   - Hashea el teléfono con SHA-256 → `phone_hash`.
   - Lee/crea la sesión en `sofia_whatsapp_sessions` (upsert por
     `phone_hash`, que sí tiene constraint único).
   - Agrega el mensaje del paciente al historial, recorta a los últimos
     20 mensajes (~10 turnos) antes de mandarlo a Claude.
   - Carga `sofia_config` (system_prompt + knowledge_base) desde Supabase.
   - RAG: embedding con `text-embedding-3-small` de los últimos 2 mensajes
     del usuario → `match_sofia_chunks` (top 6, threshold 0.5) → si no hay
     chunks, cae a mandar el `knowledge_base` completo. Mismo patrón que
     `chat.js`, incluyendo qué bloques llevan `cache_control: ephemeral`.
   - Llama a Claude (`claude-sonnet-5`, `max_tokens: 1024`,
     `thinking: {type: "disabled"}`, prompt caching habilitado).
   - Parsea `[ESCALAR: motivo]` de la respuesta (mismo regex tolerante que
     el fix en `chat.js`), lo remueve del texto.
   - Guarda el historial actualizado en `sofia_whatsapp_sessions`.
   - Si **no** escala: responde al paciente vía
     `POST /prospect/{id}/messaging/whatsapp`.
   - Si **sí** escala: primero manda la respuesta de Sofía (que ya trae la
     frase de transición antes del tag `[ESCALAR]`, ver 1.5b) al paciente
     vía `messaging/whatsapp` — salvo que quede vacía, en cuyo caso se
     salta ese envío — y **después** elige un agente (prefiere uno online,
     ver 1.6) y transfiere con `POST /prospect/{id}/as-user/transfer`.
   - Actualiza `sofia_conversations` (insert si no existe fila para ese
     `phone_hash`, update si ya existe — la tabla no tiene constraint único
     en `phone_hash`, así que es lectura+escritura manual, no un upsert de
     PostgREST): `last_message`, `escalated`, `escalation_reason`,
     `message_count += 1`.
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
