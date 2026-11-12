# Ficha para la Chrome Web Store (borrador)

Todo lo que pide el formulario de publicación, listo para pegar. **No se ha enviado nada**: la tienda se hace después de la beta y de la revisión legal.

## Datos básicos

| Campo | Valor |
| --- | --- |
| Nombre | MATATIGRE V.1 |
| Resumen (máx. 132 caracteres) | Oculta en X lo de las cuentas de las listas que elijas. Todo queda en tu navegador; solo se descargan las listas que sigues. |
| Categoría | Productividad (alternativa: Redes sociales) |
| Idioma | Español |
| Política de privacidad | <https://github.com/LarexDev/matatigre/blob/main/PRIVACY.md> |
| Página de soporte | <https://github.com/LarexDev/matatigre/issues> |
| Código fuente | <https://github.com/LarexDev/matatigre> |

## Descripción larga

MATATIGRE oculta en tu timeline de X las publicaciones de las cuentas que tú decidas, sin servidores ni cuentas.

• Eliges listas de cuentas (propias, o sincronizadas desde un repositorio público que se actualiza solo) y la extensión oculta, colapsa o resalta lo que publican, repostean, citan o mencionan.
• Pausa de 10 minutos, 1 hora o 12 horas; perfiles de un clic (Estricto, Moderado, Solo marcar); «Siempre mostrar» para las excepciones.
• Te dice por qué se ocultó cada publicación, y puedes deshacer casi cualquier cambio.
• Todo se guarda en tu navegador. No hay telemetría ni cuentas.

Modo analista (opcional y apagado por defecto): guarda en tu equipo lo que ya recibió tu navegador sobre las cuentas de tus listas y ayuda a entender cómo se relacionan (comunidades, sincronía, narrativas, temas). Nunca etiqueta a nadie ni afirma intención: describe patrones compatibles con comportamiento coordinado en una muestra parcial.

Las listas son una clasificación subjetiva de quien las cura, no una afirmación de hecho sobre nadie. Lee el descargo en el repositorio.

## Propósito único

Ocultar en X, a decisión de la persona, las publicaciones de las cuentas de sus listas. El análisis opcional trabaja sobre esas mismas cuentas y solo en el equipo de quien lo activa.

## Justificación de permisos

| Permiso | Para qué |
| --- | --- |
| `storage` | Guardar en el navegador la configuración, tus listas y, solo con el modo analista, el registro de actividad. |
| `alarms` | Actualizar las listas sincronizadas cada 12 horas, reanudar una pausa y limpiar el registro viejo. |
| `contextMenus` | Menú «Añadir a una lista» al pulsar con el botón derecho sobre un enlace a una cuenta de X. |
| Acceso a `x.com` y `twitter.com` | Leer las respuestas que X entrega a la página y la propia página para ocultar lo que corresponde. No se hace ninguna petición a X por cuenta de la extensión. |

La extensión no pide acceso a ningún otro sitio. Las listas se descargan con una petición `GET` sin cookies ni datos tuyos desde `raw.githubusercontent.com` (o desde la dirección https que tú añadas).

## Declaración de uso de datos (formulario de privacidad)

- **Recopila:** contenido del sitio web (publicaciones y cuentas públicas que X ya entregó a tu navegador) **solo si activas el modo analista**; configuración y listas del usuario. Nada más.
- **No se vende ni se transfiere** a terceros; no se usa para fines ajenos al propósito único; no se usa para crédito ni préstamos. Todo permanece en el navegador.
- **Sin código remoto:** las librerías de gráficos van incluidas (`extension/vendor/`), con sus licencias; no se carga ni se ejecuta código de internet. Las listas son datos (JSON) validados antes de usarse.

## Material gráfico

| Qué | Dónde |
| --- | --- |
| Icono 128 × 128 | `extension/icons/icon128.png` |
| Capturas 1280 × 800 | Hay que recortarlas de `docs/img/` (popup, listas, sincronizada, mapa, narrativas, modo oscuro) |
| Imagen promocional | `promo/banner-1080.png` (la tienda pide 440 × 280 pequeña y 1400 × 560 grande: pendiente de ajustar) |

## Antes de enviarla

- [ ] Revisión legal de las listas publicadas y de la redacción del descargo (datos de terceros; ver `DISCLAIMER.md`).
- [ ] Probar la beta con personas ajenas y corregir lo que aparezca.
- [ ] Capturas y banner en los tamaños de la tienda.
- [ ] Cuenta de desarrollador (pago único) con verificación en dos pasos.
- [ ] Elegir licencia para el repositorio de listas (los datos) y añadir `LICENSE`.
