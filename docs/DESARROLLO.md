# Desarrollo

JavaScript puro (ES2022), sin dependencias ni paso de compilación: la carpeta `extension/` **es** la extensión.
Las herramientas de desarrollo necesitan solo **Node.js 22 o superior**.

## Estructura

```
extension/
  manifest.json            MV3 · permiso "storage" · solo x.com / twitter.com
  src/matcher.js           Motor puro (sin DOM ni chrome.*): normalización, reglas, listas, roles, ámbitos, exenciones, saneado
  src/matcher.main.js      Copia idéntica de matcher.js para el mundo MAIN  →  npm run sync
  src/page-script.js       Mundo MAIN: hooks de fetch/XHR, proyección de tuits, filtrado en origen
  src/content.js           Mundo aislado: lectura del DOM por enlaces, atributos, estadísticas, mensajería
  src/content.css          Ocultar / colapsar / resaltar según atributos data-xaf*
  src/store.js             chrome.storage.local con valores por defecto y lista inicial
  background/              Service worker: lista inicial, estadísticas, contador del icono, atajos de teclado
  popup/  options/         Interfaces
  data/accounts.json       Lista inicial pública (~20 cuentas: usuario, etiquetas, estado)
  data/accounts.local.json Lista personal opcional (en .gitignore, excluida del empaquetado)
  icons/                   logo.svg e iconos PNG
examples/                  lista-ejemplo.json
promo/                     banner.html y banners PNG
docs/img/                  capturas usadas en el README y las guías (generadas)
tools/                     package.mjs · make-icons.mjs · make-banner.mjs · make-screenshots.mjs · sync-main.mjs
tools/demo/                feed de demostración (cuentas ficticias) para las capturas
tests/                     matcher.test.mjs · dom-fixture.html · e2e-chrome.mjs · serve.mjs · ui-harness.html · x-like.html
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

### Respaldo en el DOM (`content.js`)

X eliminó los `data-testid`, así que el DOM se lee por **enlaces**: `/usuario/status/ID` (autor + id de la publicación,
y otro id distinto = publicación citada) y `/usuario` (menciones). Se oculta la fila contenedora (`li`) mediante
atributos `data-xaf*` que `content.css` convierte en `display:none` / colapso / resaltado. El `MutationObserver`
procesa de forma síncrona (microtarea) para evitar parpadeos y detecta navegación SPA comparando `location.pathname`.

### Motor (`matcher.js`)

Función pura y sin efectos: `createMatcher(config)` devuelve `evaluate(ctx)` (qué rol coincide: autor, repost, cita,
respuesta, mención, texto, idioma), `isExempt(loc, verdict, post)`, `matchHandle()` y contadores. También:
`parseLocation()`, `compactConfig()`, `mergeSeed()` y `sanitizeConfig()` (validación de importaciones).

## Pruebas

```bash
npm test            # sincroniza matcher.main.js y ejecuta las pruebas unitarias del motor (Node, sin dependencias)
npm run test:e2e    # carga la extensión REAL en Edge/Chromium headless (XAF_BROWSER=ruta para elegir navegador)
npm run serve       # servidor de pruebas; abre http://127.0.0.1:8765/tests/dom-fixture.html y mira el título: "PASS n/n"
```

- `tests/matcher.test.mjs`: motor, ámbitos, exenciones, reglas, saneado de importaciones, validez de listas.
- `tests/dom-fixture.html`: contenido + script de página en un navegador real con DOM nuevo (sin testid) y antiguo, API
  sintética con el esquema actual y el anterior de X, XHR (texto y JSON) y `fetch`, módulos de conversación,
  exenciones por ruta, modos, rendimiento y diagnóstico.
- `tests/e2e-chrome.mjs`: arranca el navegador con la extensión sin empaquetar y comprueba carga, service worker,
  filtrado en origen por `fetch` y `XHR`, filtrado en el DOM, cambios de configuración en caliente, popup y opciones.
  Es independiente de cualquier lista personal.

> Chrome de marca ≥ 137 ignora `--load-extension`; por eso `test:e2e` usa Edge por defecto. La instalación manual
> ("Cargar extensión sin empaquetar") funciona en todos.

## Empaquetar y publicar una versión

1. Actualiza la versión en `extension/manifest.json` **y** `package.json` (deben coincidir) y anota los cambios en `CHANGELOG.md`.
2. `npm test` y `npm run test:e2e`.
3. `npm run build` → `dist/matatigre-v<versión>.zip` (excluye siempre `accounts.local.json`).
4. Etiqueta y publica:

   ```bash
   git tag v1.0.0
   git push origin main --tags
   gh release create v1.0.0 dist/matatigre-v1.0.0.zip --title "MATATIGRE V.1 v1.0.0" --notes-file CHANGELOG.md
   ```

## Regenerar recursos gráficos

```bash
npm run icons     # icon16/32/48/128.png desde extension/icons/logo.svg (necesita Edge o Chrome)
npm run banner    # promo/banner-1080.png y banner-2160.png desde promo/banner.html
npm run screenshots  # docs/img/*.png: Chrome real + la extensión real sobre un feed de demostración (cuentas ficticias)
```

## Si X cambia su sitio

1. Abre el popup en una pestaña de X → **Copiar diagnóstico**. Informa de: si el hook está activo, cuántas respuestas
   GraphQL vio, las claves de un tuit (`tweetKeys`), cuántas citas/reposts/respuestas detectó y la **estructura** (sin
   texto) del primer `article`.
2. Si `pageScript.graphql` es 0: X cambió el transporte o la ruta (`/graphql/…`); ajusta `GRAPHQL` en `page-script.js`.
3. Si hay tuits pero no citas/reposts: ajusta `QUOTE_PATH` / `RETWEET_PATH` / `REPLY_KEY` en `page-script.js`.
4. Si falla el respaldo del DOM: ajusta `STATUS_HREF`, `PROFILE_HREF` o `rowOf()` en `content.js`.
5. Añade el caso a `tests/dom-fixture.html` antes de corregir.
