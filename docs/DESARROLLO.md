# Desarrollo

JavaScript puro (ES2022), sin paso de compilación: la carpeta `extension/` **es** la extensión. No hay dependencias de ejecución salvo dos librerías de gráficos incluidas tal cual en `extension/vendor/` (Cytoscape.js y Apache ECharts; ver su `README.md` para versiones, licencias y cómo actualizarlas).
Las herramientas de desarrollo necesitan solo **Node.js 22 o superior**.

## Estructura

```
extension/
  manifest.json            MV3 · permisos "storage" y "alarms" · solo x.com / twitter.com
  src/matcher.js           Motor puro (sin DOM ni chrome.*): normalización, reglas, capas de listas, roles, ámbitos, exenciones, validación
  src/matcher.main.js      Copia idéntica de matcher.js para el mundo MAIN  →  npm run sync
  src/page-script.js       Mundo MAIN: hooks de fetch/XHR, proyección de tuits, filtrado en origen
  src/content.js           Mundo aislado: lectura del DOM por enlaces, atributos, estadísticas, mensajería
  src/content.css          Ocultar / colapsar / resaltar según atributos data-xaf*
  src/store.js             chrome.storage.local con valores por defecto, metadatos y lista local opcional
  src/lists.js             Descarga, validación y copia local de las listas suscritas (solo escribe el service worker)
  background/              Service worker: bienvenida y migración, sincronización de listas (alarma de 12 h), estadísticas, icono, atajos
  welcome/                 Pantalla de bienvenida: catálogo y suscripción a listas
  popup/  options/         Interfaces
  icons/                   logo.svg e iconos PNG
examples/                  lista-ejemplo.json
promo/                     banner.html y banners PNG
docs/img/                  capturas usadas en el README y las guías (generadas)
tools/                     package.mjs · make-icons.mjs · make-banner.mjs · make-screenshots.mjs · sync-main.mjs
tools/demo/                feed de demostración (cuentas ficticias) para las capturas
tests/                     matcher.test.mjs · radar.test.mjs · graph.test.mjs · dom-fixture.html · e2e-chrome.mjs · serve.mjs · ui-harness.html · x-like.html
docs/                      documentación
```

## Arquitectura

### Dos mundos de JavaScript

Una extensión no puede interceptar `fetch`/`XMLHttpRequest` de la página desde su mundo aislado, así que el
manifiesto declara dos *content scripts* a `document_start`:

| Mundo | Archivos | Responsabilidad |
| --- | --- | --- |
| `MAIN` (el de la página) | `matcher.main.js`, `page-script.js` | Interceptar respuestas GraphQL, decidir y **quitar** publicaciones de la respuesta. |
| Aislado (el de la extensión) | `matcher.js`, `store.js`, `content.js` | Leer la configuración (`chrome.storage`), leer el DOM y aplicar atributos, estadísticas, mensajes con el popup y el service worker. |

> Chrome no inyecta dos veces el **mismo archivo** desde dos entradas de `content_scripts`; por eso el mundo `MAIN`
> usa `matcher.main.js`, una copia byte a byte. `npm run sync` la regenera y `npm test` falla si difiere.

### Comunicación entre mundos

- `CustomEvent` en `document` con `detail` en JSON (los objetos no cruzan mundos): `matatigre:config` (→ página),
  `matatigre:hello`, `:hits`, `:drops`, `:diag` (→ extensión).
- Espejo de la configuración compacta en `localStorage['matatigre.cfg']`, para que el hook tenga la lista desde la
  primera petición de la página (antes de que `chrome.storage` responda).

### Filtro en origen (`page-script.js`)

1. Hook de `fetch` y `XMLHttpRequest` (se enganchan los getters `response` y `responseText`) hacia `/graphql/<hash>/<Operación>`.
2. Recorrido iterativo del JSON. Un tuit se reconoce estructuralmente (`rest_id` + autor/texto), no por el nombre de la operación.
3. Proyección **tolerante** de cada tuit: autor, nombre, biografía, texto, idioma, cita, repost, respuesta y menciones.
   X cambia el esquema con frecuencia, así que cada campo se busca por nombre en varias rutas y se complementa con el texto.
4. Decisión con `matcher.evaluate()` + `matcher.isExempt()` (ámbito, perfil propio, publicación abierta, lista blanca).
5. En modo *Ocultar*, se eliminan de las listas de entradas (`entries` / `items` de módulos) y se avisa con `:drops`.
   En los demás modos se envían `:hits` para que el DOM aplique colapsar o resaltar.
6. **Cualquier error devuelve la respuesta original intacta**: el script no debe romper X.

### Registro local (fase 0 del análisis)

Todo es opcional (`settings.observe`, apagado por defecto); con el registro apagado el script de página no extrae nada y no existe la base de datos.

- **Qué se registra (`relevance`).** Solo lo que toca a las cuentas de las listas, decidido con `matcher.isTracked(handle, uid)` (cualquier cuenta de cualquier lista, esté encendida o no): `a` lo publica o reposta una cuenta de la lista, `p`/`r`/`q` alguien responde, reposta o cita a una, `m` la menciona, `t` es la publicación original a la que alguien de la lista respondió, reposteó o citó. El motivo se guarda en `rel`.
  **Se registra antes de quitar de la respuesta** (`observeTree` en la ruta de descarte del modo *Ocultar*): lo que el usuario ya no ve es justo lo que interesa analizar.
- **Captura (`page-script.js`).** `describe()` convierte cada tuit en un registro compacto (`observe.js` documenta las claves): tipo (post, repost, cita, respuesta), id y hora (`details.created_at_ms`), autor con su `rest_id`,
  contadores, enlaces, hashtags, menciones con id, medios y aplicación de origen. Cada campo se busca en varias rutas (el esquema cambia). Se envía en lotes por `matatigre:obs`, sin repetir ids en una misma carga.
- **Canal.** `content.js` reenvía los lotes al service worker (≤ 200 registros cada 2 s) con `xaf:obs`; el service worker descarta lo que llegue si el ajuste está apagado.
- **Validación (`observe.js`, puro y probado en Node).** `toRecord()` valida y normaliza (ids, handles, horas, tamaños), `canonicalUrl()` quita parámetros de seguimiento y acortadores, `normalizeForMatch()` prepara el texto y `sha256Hex()` da la huella.
- **IndexedDB (`db.js`, `ingest.js`).** Base `matatigre` con migraciones versionadas. Almacenes: `profiles` (identidad observada por `u:<rest_id>`: nombres de usuario, cifras públicas y avisos; sin nada escrito a mano), `handles`, `obs` (por `<tuit>:<tipo>`), y de uso futuro `meta`, `runs`, `cases`, `evidence` y `audit`.
  Solo el service worker escribe (con cerrojo). Perfiles: el handle puede cambiar sin perder el perfil (historial); si un handle conocido llega con otro id se marca `flags.reassignedFrom` / `flags.handleLostTo` y no se hereda nada.
  Observaciones: idempotentes, conservan los primeros contadores (`counts0`) para medir crecimiento.
- **Retención (`purge`, alarma diaria).** El texto se quita a los `keepTextDays` días (queda la huella); lo visto hace más de 180 días se borra; tope de 200 000. **Lo anclado a un expediente** (almacén `evidence`, índice `obsId`) no se borra ni pierde su texto.
- **Esquema comprobado con sesión iniciada** (informe del 2026-11-08): los datos del tuit siguen en `legacy` (`created_at`, contadores, `entities`, `extended_entities.media[].media_key`, `conversation_id_str`, `quoted_status_id_str`, `in_reply_to_*`); `core.user_results.result` trae `rest_id`, `core.created_at` (alta de la cuenta), `relationship_counts`, `tweet_counts`, `verification`, `privacy.protected`;
  los textos largos traen las entidades completas en `note_tweet…entity_set`; una cita puede llegar solo como referencia (`quotedRefResult` + `quoted_status_id_str`); los medios reutilizados traen `source_status_id_str`; la aplicación de origen (`source`) casi no aparece y no se usa como señal. Todo esto está cubierto en las pruebas.
- **Sondeo del esquema.** El script de página registra las **rutas** de campos de los primeros 300 tuits y usuarios (nunca valores) y las emite por `matatigre:schema`; salen en el informe de *Opciones → Copia y datos → Copiar informe para soporte* (`schema.candidates` resalta
  campos de interés: fechas de creación, aplicación de origen, claves de medios, contadores). Sirve para comprobar con una sesión real qué campos entrega X.
- **No hay peticiones a X**: solo se guarda lo que el navegador ya recibió.

### Radar de coordinación y expedientes (fase 2)

- **Datos.** La ingesta guarda por observación `th` (SHA-256 truncado del texto normalizado), `sh` (**SimHash** de 64 bits sobre bigramas de palabras), `tl` y `tw` (longitud y palabras); sobreviven a la retención del texto.
- **`radar.js` (puro, probado en Node con datos sintéticos de verdad conocida).** `analyze(obs, { from, to })` construye candidatos a evento (texto: unión de duplicados exactos y casi duplicados con SimHash a distancia ≤ 6 usando 7 bandas de 9-10 bits, de modo que con distancia ≤ 6 al menos una banda coincide;
  enlace, hashtags y raíz) y los analiza: cuentas distintas (la primera observación de cada una), ventana deslizante `maxWithin`, indicadores I1–I5, nivel E0/E1, estabilidad (cuántas de 5 ventanas la mantienen), cobertura (reposteros observados / `counts.rt` de la publicación original si se observó) y explicaciones alternativas
  (fuente común, tendencia por franjas de 10 min con el propio evento excluido de la línea base, publicación con alcance ≥ 500, cobertura < 30 %, misma búsqueda o lista). El grafo y E2–E3 los resuelve `graph.js` (ver abajo).
  **Por cuenta (`accountsReport`).** A partir de `rel` (por qué se registró cada observación) y de los eventos E1 resume, para cada cuenta, cuatro señales con umbrales fijos y la evidencia: S1 texto sincronizado (≥ 2 eventos de texto E1), S2 reposts sincronizados (≥ 2 eventos de reposts E1), S3 respuestas o citas repetidas a una misma cuenta de las listas (≥ 5) y S4 amplificación concentrada (≥ 8 interacciones directas, ≥ 60 % a una cuenta); más la lista de cuentas que no son de las listas y más interactúan con ellas. Es una lista de verificación, no una puntuación ni una etiqueta; los mismos umbrales para cualquier bando (prueba de simetría). Prueba de escala: 20 000 observaciones en ~1,5 s sin falsos E1.
- **Worker (`analysis/worker.js`).** La página de opciones lanza el Worker, que abre IndexedDB en solo lectura, lee el índice `t` del periodo y devuelve los eventos con los nombres de usuario de los perfiles. No escribe ni hace peticiones.
- **`cases.js`.** Parte pura (expediente, evidencia mínima, `canonicalJson`, paquete con huella SHA-256 sobre capas+expediente+evidencia+cuentas, `verifyPackage`, informe HTML con todo escapado y seudónimos `C-xxxxxxxx` por expediente) y operaciones sobre IndexedDB en el service worker
  (almacenes `cases` y `evidence`; cada cambio añade una entrada a `audit`). La evidencia anclada tiene índice por `obsId` y la retención no la toca.

### Análisis relacional (`graph.js`)

- **Entrada.** Las observaciones y los eventos del radar (que ahora traen `obsIds` de todas las publicaciones del evento). `analyzeGraph(rows, events, { attrs })` es puro y se prueba en Node con datos sintéticos de verdad conocida (`tests/graph.test.mjs`: núcleo recuperado, control nulo sin falsos positivos, coincidencia suelta que no basta, comunidades separadas, apoyo concentrado, roles, narrativas, determinismo/simetría y escala de 20 000 observaciones).
- **Interacciones (`buildInteractions`).** Aristas dirigidas respuesta/cita/repost (a partir de `targetAuthorUid` o del autor de la publicación original ya registrada) y menciones a cuentas de las listas. "De la lista" = `rel` con `a` o destinataria de una interacción directa registrada; "vigilada" = `rel` con `w`.
- **Sincronía (`coparticipation`).** Para cada evento con ≥ 2 cuentas, los pares cuyas horas están a menos de τ (60 s texto exacto; 10 min texto casi idéntico, enlace y hashtags; 5 min reposts) suman un peso 1/ln(1+n). Los pares con ≥ 3 eventos en común pasan a la prueba: se desplaza circularmente, de forma independiente, el conjunto de horas de cada cuenta dentro del periodo observado (400 permutaciones, semilla fija), se recalcula el peso y p = (1 + #{w* ≥ w}) / (1 + 400); q = Benjamini–Hochberg sobre todos los pares probados. E1 coincidencia; E2 q < 0,05; E3 además persistente (≥ 6 h o ambas mitades del periodo), con ≥ 2 eventos de texto y sin explicación alternativa en más de un tercio de los eventos.
- **Comunidades (`communities`).** Louvain (modularidad) sobre interacciones ponderadas `log2(1+n)` más las aristas E2/E3; 10 ejecuciones con semillas distintas y solo se mantienen unidas las cuentas que quedan juntas en ≥ 80 % de ellas. Informa densidad, estabilidad y modularidad.
- **Relevancia.** PageRank sobre las interacciones; `roles`: quién publica primero (proporción con intervalo de Wilson al 95 %), retardo mediano de los seguidores y dependencia de una sola cuenta (índice de Herfindahl). Etiquetas descriptivas (*inicia*, *sigue de cerca*, *depende de una cuenta*), sin puntuaciones.
- **Narrativas (`narratives`).** Unión de eventos que comparten publicaciones; origen (primeras cuentas), arranque (cuentas en los primeros 5 min), curva acumulada y volumen, concentración (cuota de las 5 más activas, Gini), cuota de cuentas de las listas y comunidades implicadas.
- **Hallazgos (`buildFindings`).** Cada uno lleva `kind`, `level`, `accounts`, `evidence` (ids de publicación), `criteria` (etiqueta y valor), `alternatives` y `stability`; las narrativas ya explicadas por un núcleo no se repiten. Nunca hay una etiqueta sobre personas.
- **Sensibilidad a la ventana.** Con `tauScale` 0,5 y 2 (150 permutaciones) se repite la prueba de pares; `holds` = en cuántas de las 3 ventanas el par sigue con q < 0,05. E3 exige `holds` = 3; la estabilidad de un núcleo es *alta* si todos sus pares tienen `holds` ≥ 2 y al menos el 80 % tiene 3. Un calendario muy regular (eventos cada N horas) hace que el desplazamiento circular vuelva a alinear las horas: los datos de prueba lo evitan con una hora de inicio irregular por evento.
- **Lista de verificación (`checklists`).** C1 (≥ 2 eventos de texto E1 y sincronía significativa), C2 (≥ 8 publicaciones en ≥ 3 días con ≥ 80 % en 2 franjas de 6 h), C3 (≥ 5 respuestas o citas a una misma cuenta de las listas), C4 (≥ 8 interacciones, ≥ 60 % a una cuenta y concentración ≥ 0,4), C5 contexto y C6 no evaluado; el estado es `cumple`, `no cumple` o `sin datos`. `review` = ≥ 3 de C1–C4 y una pareja E3. Sin puntuaciones.
- **Términos distintivos (`distinctive`).** Razón de probabilidades logarítmica con prior de Dirichlet informativo (Monroe et al.), con `z` ≥ 2,5 y al menos 4 apariciones; se muestra el recuento dentro y fuera de la comunidad.
- **Comparación entre listas (`listComparison`).** La pertenencia la manda la página de opciones (`lists`: nombre de usuario → listas) y el worker la resuelve con los nombres de los perfiles.
- **Distribución (`layout`).** Fuerzas con comunidades agrupadas al inicio, atracción normalizada por grado y distancia mínima; semilla fija (misma red, mismo dibujo). `options/analysis-view.js` dibuja el SVG (zoom, arrastre, filtros, tooltip, selección) y las curvas de narrativa.
- **Cuentas vigiladas.** `ingest.computeWatch` (≥ 3 interacciones directas de cuentas que no son de las listas, máx. 300) lo ejecuta el service worker (`refreshWatch`, como mucho cada 10 min y en la purga diaria) y lo guarda en la clave `watch` (fuera de `KEYS`: cambiarla no recarga la configuración). El content script la envía al script de página (`matatigre:watch`) y `relevance` añade `w`. Ajuste `watch` (activo por defecto, solo efectivo con `observe`).

### Análisis: periodos de actividad, calibración, temas y comunidades (`graph.js`)
- **Modelo nulo por periodos de actividad.** El registro solo contiene lo que se vio mientras se navegaba: barajar las horas por todo el reloj movería cuentas a huecos donde nadie podía coincidir y toda sincronía parecería significativa. `activitySegments(times, gapMs)` une los periodos con actividad (huecos > 2 h se descartan) en un eje compacto; el desplazamiento circular de cada cuenta se hace sobre ese eje y las ventanas se miden en hora real. Con un solo periodo es el comportamiento clásico. Limitación asumida: si solo hay unas pocas ráfagas aisladas, la resolución del contraste es el número de ráfagas (no se puede demostrar nada con datos así, y es lo correcto).
- **Observado frente a esperado.** Cada par trae `expectedSupport`: la media de coincidencias de las permutaciones. Los hallazgos y las aristas lo muestran junto a lo observado.
- **Calibración con los propios datos** (`calibration`): `placebo()` baraja las horas (una realización del modelo nulo: no hay coordinación por construcción), pasa el mismo detector 3 veces y cuenta los pares significativos (debe ser ≈ 0). Además, el histograma de valores p de los pares reales (plano si no hay señal). No necesita población de control. Suficiencia (`sample.activity`): *escasa* / *parcial* / *suficiente* según días y horas de actividad (umbrales heurísticos: 3 días y 6 h; 7 días y 24 h).
- **Actividad simultánea entre comunidades** (`crossCommunity`): en franjas de 10 min, un pico de una comunidad es una franja con muchas más cuentas distintas activas de lo habitual en ella (≥ cuantil 0,9 y ≥ 3). Se cuentan los picos coincidentes entre pares de comunidades y se compara con desplazamientos circulares de una de las dos series (500), con Benjamini–Hochberg entre todos los pares. Se descartan las franjas en que se activa la mitad o más de las comunidades (acontecimiento general). Es independiente del contenido: se informa además el vocabulario compartido en esos picos, que permite ver a comunidades con narrativas distintas moviéndose a la vez. Control nulo medido: 1 pareja con E2 en 703 comprobadas con datos aleatorios.
- **Temas definidos por la persona** (`topicStats`): palabras enteras, prefijos con `*`, frases y hashtags, sin tildes ni mayúsculas, sobre el texto normalizado. Reparto por comunidad, curva, primeras cuentas y parejas sincronizadas dentro del tema. `sharedTerms` sugiere palabras que usan ≥ 2 comunidades y que no aparecen en más del 15 % del registro. Los temas se guardan en `chrome.storage.local.topics` (no recargan la configuración) y viajan en la copia de seguridad.
- **Palabras vacías:** `tokensOf` solo deja palabras con contenido (`isContent`: ≥ 4 letras, fuera la lista `STOP` —sin tildes, como el texto normalizado—, números, risas y alargamientos). Las usan los términos distintivos, las palabras compartidas y los picos simultáneos. Las palabras clave de una narrativa son tf·idf: frecuencia en ella (≥ 30 % de sus publicaciones y ≥ 2) por rareza en el registro. Los términos distintivos exigen además una **concentración** mínima: tasa dentro de la comunidad ≥ 3 veces la de fuera (así el tema de fondo del registro no distingue a nadie). Los temas definidos por la persona no pasan por este filtro: cuenta lo que escribe.
- **Candidatas externas:** una cuenta externa con ≥ 3 interacciones directas con las listas es *afín* (amplifica, no indica coordinación) o *sincronizada* (además tiene pares significativos E2/E3).
- **Interfaz:** `options/analysis-tab.js` (secciones, panel lateral, temas, expedientes), `options/analysis-view.js` (Cytoscape.js para el mapa y Apache ECharts para las curvas; los colores salen de las variables CSS y se redibujan al cambiar de tema), `vendor/` (las librerías). El mapa es de burbujas: `packCircles` coloca los círculos tangentes entre sí lo más cerca del centro (sin solaparse) y `bubbleLayout` empaqueta cada comunidad y luego las comunidades entre sí; los halos son nodos aparte de baja opacidad detrás de las cuentas. Solo se dibujan por defecto la sincronía y las relaciones más fuertes (≈ 0,9 por cuenta). El zoom del mapa es con Ctrl + rueda para no secuestrar el desplazamiento de la página. El mapa se dibuja al mostrar su sección (un contenedor oculto no tiene tamaño).

### Listas propias y gestión de listas
- **Modelo.** `cfg.myLists` = `{ id: { name, created } }` (clave `myLists`, dispara recarga) son las listas propias; `accounts[k].tags` guarda sus ids. `src/mylists.js` (puro, probado en `tests/mylists.test.mjs`) concentra las operaciones (`create`, `rename`, `remove`, `addAccounts`, `removeFromList`, `copyAccounts`, `checkName`…). `store.load()` devuelve `myLists` ya resuelto: las guardadas más las etiquetas heredadas de versiones anteriores (el service worker las persiste al arrancar). Una lista propia nunca comparte id con una sincronizada.
- **Reglas.** El contenido sincronizado (`listData`) nunca se modifica desde la interfaz; lo único que se guarda por el usuario sobre una sincronizada es el interruptor (`lists`), el modo (`listModes`) y las cuentas omitidas (`disabled`). Copiar a una lista propia crea cuentas propias.
- **Interfaz.** `options/lists-view.js` (pestaña *Listas*: columna de listas + vistas *propia*, *sincronizada*, *todas* y *explorar*; los cambios se aplican en memoria, se persisten y se pueden deshacer con una instantánea), `popup/ui.js` (`MTUI.dialog/confirm/prompt/toast`). Los cambios que hace la propia página no se vuelven a dibujar (se compara el estado cargado con el actual).
- **Botón de añadir rápido.** `content.js` lista `config.myLists`, no crea listas y manda a las opciones (`xaf:openOptions`, ruta `#lists/new`) si no hay ninguna; `addAccount` valida que las listas existan.
- **Apariencia.** `popup/ui.css` define las variables (claro, oscuro con `prefers-color-scheme` y forzado con `data-theme`) y `color-scheme`; `popup/theme.js` aplica el ajuste `settings.theme` antes de pintar (con copia en `localStorage`). Todo color nuevo debe ser una variable.

### Modo analista, avisos y límites
- **Modo analista** (`settings.analyst`, apagado por defecto): sin él no hay pestaña *Análisis* y el registro no corre aunque `observe` esté activo. `XAF.captureOn(settings)` es la única regla (la usan el script de página, el content script y el service worker). Quien ya tenía el registro encendido conserva el análisis (`analyst` se deriva de `observe` si falta).
- **Fallo silencioso:** `content.js` comprueba cada 15 s (`health()`) si hay publicaciones en pantalla que el filtro no reconoce (`'api'`: X devuelve datos y no se proyecta ninguna; `'dom'`: ninguna con id legible). Con dos comprobaciones seguidas se avisa: «!» ámbar en el icono (el service worker lo pinta) y un aviso en el popup. Si la extensión se actualiza con X abierto, el script huérfano lo detecta (`chrome.runtime.id`) y muestra «Recarga la página».
- **Límites** (`XAF.LIMITS`): 5 000 cuentas por lista, 25 000 entre todas las sincronizadas, 30 listas y 20 000 cuentas propias. Medido: el filtro tarda ≈170 ms en construirse con 50 000 cuentas. Una lista que no cabe se rechaza con un mensaje claro y, al actualizar, se conserva la copia anterior.
- **Transparencia:** el veredicto trae `lists` (qué listas lo motivan; las reglas llevan su etiqueta). Salen en la barra de una publicación colapsada o resaltada y en *Ocultadas recientemente* del popup, con «Siempre mostrar». Al actualizar una lista sincronizada se guarda en `meta.status[id].change` qué entró y qué salió (con una muestra) y si fue un cambio grande (≥ 25 %); se ve en la lista.

### Reconocimiento por id y menú contextual (fase 1)

- **Filtrado por id.** `composeConfig` asigna a cada cuenta su `uid` (el de la lista, el de la cuenta propia o el aprendido en `uids`). `matchHandle(handle, name, bio, uid)`: con id conocido coincide aunque el nombre sea otro (`renamed`); si el nombre de una cuenta con id aparece con **otro** id,
  no coincide (reasignado); si coincide por nombre y la cuenta aún no tiene id, el veredicto trae `learn: { h, id }`. El script de página extrae los ids (autor, citado, quien reposta) y envía una sola vez cada par por `matatigre:ids`; el service worker (`learnIds`) lo guarda en `uids`
  solo si la cuenta está en la configuración, no sobrescribe ids conocidos y poda los de cuentas que ya no están.
- **Menú contextual.** `chrome.contextMenus` (permiso `contextMenus`), solo sobre enlaces de x.com/twitter.com; se reconstruye al cambiar las cuentas (`buildMenu`). `handleMenuClick` valida el enlace (dominio y ruta de cuenta o publicación) y pide a la pestaña que haga la acción (`xaf:menuAdd`), así que reutiliza el aviso y *Deshacer*.

### Insignia «Añadir» y tarjeta de listas (`content.js`)

La **insignia** (`span.matatigre-badge`, atributo `data-xaf-badge`) es el único elemento que se inserta dentro de la página: un hijo del `<article>` posicionado en absoluto en su esquina superior derecha (`article[data-xaf-host]` pasa a `position: relative`), de modo que **no mueve nada del diseño** de X (`syncBadge`, llamado desde `processArticle`).
No se mide al insertarla (leer el diseño por cada publicación forzaría un reflujo cada vez); al entrar el ratón en la publicación, `placeBadge` la coloca a la izquierda del icono más a la izquierda de la cabecera (menú, Grok…). Se ve solo al pasar el ratón (CSS `article:hover`).
Si X repinta la cabecera, el `MutationObserver` vuelve a procesar la publicación y la reinserta. Un `click` en fase de captura la atiende y detiene la propagación para que X no abra la publicación.
El icono va incrustado en el CSS (`data:`), por lo que no hace falta `web_accessible_resources` ni se expone el identificador de la extensión a la página.

La **tarjeta** (`#matatigre-card`) y el **aviso** (`#matatigre-toast`) son elementos propios añadidos a `<html>`, fuera del árbol de X. La tarjeta ofrece las listas propias existentes (`config.myLists`; las sincronizadas son de solo lectura y las listas nuevas se crean en las opciones), *Añadir* (activo al elegir una) y *Siempre mostrar*, y adapta su tema al fondo de X (`isDark`).
Escribe en `chrome.storage` (cuenta manual con las listas elegidas, y la quita de las excepciones y de las cuentas omitidas); *Deshacer* restaura el estado anterior. Ajuste: `settings.addButton`.

### Respaldo en el DOM (`content.js`)

X eliminó los `data-testid`, así que el DOM se lee por **enlaces**: `/usuario/status/ID` (autor + id de la publicación,
y otro id distinto = publicación citada) y `/usuario` (menciones). Se oculta la fila contenedora (`li`) mediante
atributos `data-xaf*` que `content.css` convierte en `display:none` / colapso / resaltado. El `MutationObserver`
procesa de forma síncrona (microtarea) para evitar parpadeos y detecta navegación SPA comparando `location.pathname`.

### Listas suscribibles (`lists.js`, `welcome/`)

Las cuentas ya no viajan en el paquete. Un repositorio de datos aparte (`matatigre-listas`) publica `index.json` (catálogo) y un JSON por lista; el
formato está en su [FORMATO.md](https://github.com/LarexDev/matatigre-listas/blob/main/FORMATO.md).

- **Capas.** `chrome.storage.local` guarda `subs` (suscripciones: id, nombre, url, origen), `listData` (última copia buena de cada lista, de solo lectura),
  `disabled` (cuentas de listas que el usuario apagó) y `lists` (interruptores por lista). `accounts` son las cuentas propias. `composeConfig()` (en `matcher.js`) las aplana en
  `{ settings, accounts, lists, rules, allowlist }`: cada cuenta de una suscripción lleva como etiqueta el id de su lista, de modo que el mecanismo de listas/etiquetas
  que ya existía sirve tal cual. `createMatcher()` y `compactConfig()` componen internamente, así que el script de página no cambió.
  Precedencia: lista blanca > cuenta propia desactivada > cuenta propia > suscripciones.
- **Único escritor.** Solo el service worker descarga y guarda listas (`XAF.lists`, con un cerrojo que serializa las operaciones). Las páginas de la extensión le piden
  operaciones con mensajes `{ type: 'xaf:lists', op }` (`catalog`, `subscribe`, `subscribeUrl`, `unsubscribe`, `sync`, `prune`, `legacy`); el service worker ignora los
  mensajes de listas que no vengan de una página de la propia extensión (un content script en x.com no puede suscribir).
- **Red.** `fetch` con `credentials: 'omit'`, sin `Referer`, 15 s de límite y 2 MB como máximo. No hay permisos de host adicionales: basta con que el servidor
  responda con `Access-Control-Allow-Origin: *` (GitHub lo hace). Solo https (y http hacia la propia máquina, para pruebas); también se comprueba la URL final tras redirecciones.
- **Validación.** `sanitizeList()` y `sanitizeCatalog()` normalizan, quitan duplicados, acotan tamaños y descartan lo no válido. Si una descarga falla o no valida, se conserva la copia anterior y el error
  queda en `meta.status[id]`. Esas claves de estado (`meta`, `catalog`) no disparan recargas del filtro; solo `subs`, `listData` y `disabled` lo hacen, y únicamente cuando cambia el contenido.
- **Sincronización.** Alarma de 12 h (`chrome.alarms`) y comprobación al arrancar el navegador. Una lista en `withdrawn` del catálogo se elimina del usuario.
- **Bienvenida y migración.** Al instalar se abre `welcome/welcome.html`. Al actualizar desde la 1.x con cuentas de la lista inicial sin tocar (`source: 'seed'`, `touched: false`), se abre con `?migrate=1`:
  esas cuentas **siguen funcionando** hasta que el usuario acepta; entonces se suscribe y `prune` retira solo las que ya están en una lista descargada. Los ids del catálogo coinciden con las etiquetas de la 1.x
  (`abelardo`, `abelardista`, `petro`, `petrista`, `antipetrista`), así que los interruptores de lista que el usuario ya tenía se conservan.
- **Desarrollo y pruebas.** La clave `catalogUrl` de `chrome.storage.local` (solo se lee si es una URL admisible) cambia el catálogo; las pruebas e2e y las capturas la apuntan a un servidor local con CORS.

### Motor (`matcher.js`)

Función pura y sin efectos: `createMatcher(config)` devuelve `evaluate(ctx)` (qué rol coincide: autor, repost, cita,
respuesta, mención, texto, idioma), `isExempt(loc, verdict, post)`, `matchHandle()` y contadores. Cada veredicto lleva su `mode`: el más restrictivo entre
las listas encendidas de la cuenta (cada una con `listModes[id]` o el modo general); con varios roles, `evaluate` devuelve el de modo más restrictivo (ocultar > colapsar > resaltar). También:
`parseLocation()`, `compactConfig()`, `composeConfig()`, `sanitizeConfig()` (importaciones), `sanitizeList()`/`sanitizeCatalog()` y `isAllowedListUrl()`/`resolveListUrl()`.

## Pruebas

```bash
npm test            # sincroniza matcher.main.js y ejecuta las pruebas unitarias del motor (Node, sin dependencias)
npm run test:e2e    # carga la extensión REAL en Edge/Chromium headless (XAF_BROWSER=ruta para elegir navegador)
npm run serve       # servidor de pruebas; abre http://127.0.0.1:8765/tests/dom-fixture.html y mira el título: "PASS n/n"
```

- `tests/matcher.test.mjs`: motor, ámbitos, exenciones, reglas, saneado de importaciones, capas y suscripciones (precedencia, interruptores, cuentas apagadas), validación de listas y catálogo, URLs admisibles, y que el paquete no incluya cuentas públicas.
- `tests/dom-fixture.html`: contenido + script de página en un navegador real con DOM nuevo (sin testid) y antiguo, API
  sintética con el esquema actual y el anterior de X, XHR (texto y JSON) y `fetch`, módulos de conversación,
  exenciones por ruta, modos, rendimiento y diagnóstico.
- `tests/e2e-chrome.mjs`: arranca el navegador con la extensión sin empaquetar y comprueba carga, service worker,
  filtrado en origen por `fetch` y `XHR`, filtrado en el DOM, cambios de configuración en caliente, popup y opciones.
  Levanta un servidor de listas con CORS y prueba el ciclo completo: bienvenida y suscripción, estado por defecto de cada lista, actualización en caliente, servidor caído o JSON inválido (se conserva la copia buena),
  recuperación, migración desde la 1.x, retirada de una lista del catálogo, baja y suscripción por URL. Corre sobre una copia de la extensión, así que no toca el perfil ni los archivos del repositorio.

> Chrome de marca ≥ 137 ignora `--load-extension`; por eso `test:e2e` usa Edge por defecto. La instalación manual
> ("Cargar extensión sin empaquetar") funciona en todos.

## Empaquetar y publicar una versión

1. Actualiza la versión en `extension/manifest.json` **y** `package.json` (deben coincidir) y anota los cambios en `CHANGELOG.md`.
2. `npm test` y `npm run test:e2e`.
3. `npm run build` → `dist/matatigre-v<versión>.zip` (excluye por seguridad cualquier `accounts.local.json`: la extensión ya no admite listas locales).
4. Etiqueta y publica:

   ```bash
   git tag v2.0.0
   git push origin main --tags
   gh release create v2.0.0 dist/matatigre-v2.0.0.zip --title "MATATIGRE V.1 v2.0.0" --notes-file CHANGELOG.md
   ```

## Regenerar recursos gráficos

```bash
npm run icons     # icon16/32/48/128.png desde extension/icons/logo.svg (necesita Edge o Chrome)
npm run banner    # promo/banner-1080.png y banner-2160.png desde promo/banner.html
npm run screenshots  # docs/img/*.png: Chrome real + la extensión real sobre un feed y un catálogo de listas de demostración (cuentas ficticias)
```

## Actualizar las listas

Las listas no se publican con la extensión: viven en el repositorio `matatigre-listas`. Para cambiarlas, edita `listas/<id>.json`, actualiza `count`, `version` y `updated`
(y `index.json` si cambia el catálogo), ejecuta `node tools/validate.mjs` y publica en `main`. Los usuarios reciben el cambio en su próxima comprobación (hasta 12 h).
Para retirar una lista entera, quítala de `lists` y añade su id a `withdrawn`.

## Si X cambia su sitio

1. Con una pestaña de X abierta, en Opciones → Copia y datos → **Copiar informe para soporte**. Informa de: si el hook está activo, cuántas respuestas
   GraphQL vio, las claves de un tuit (`tweetKeys`), cuántas citas/reposts/respuestas detectó y la **estructura** (sin
   texto) del primer `article`.
2. Si `pageScript.graphql` es 0: X cambió el transporte o la ruta (`/graphql/…`); ajusta `GRAPHQL` en `page-script.js`.
3. Si hay tuits pero no citas/reposts: ajusta `QUOTE_PATH` / `RETWEET_PATH` / `REPLY_KEY` en `page-script.js`.
4. Si falla el respaldo del DOM: ajusta `STATUS_HREF`, `PROFILE_HREF` o `rowOf()` en `content.js`.
5. Añade el caso a `tests/dom-fixture.html` antes de corregir.
