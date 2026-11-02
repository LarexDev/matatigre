# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [1.0.0] · 2026-11-01

Primera versión pública.

### Añadido
- Filtro en origen: intercepta las respuestas GraphQL de X (`fetch` y `XMLHttpRequest`) y elimina las publicaciones
  coincidentes antes de que se pinten. Proyección tolerante a cambios de esquema.
- Respaldo en el DOM sin depender de `data-testid`: lectura por enlaces `/usuario/status/ID`.
- Coincidencias por autor, repost, cita, respuesta y mención; sugerencias de personas.
- Modos Ocultar, Colapsar y Resaltar.
- Reglas por handle, nombre, biografía, texto e idioma (comodín, "contiene" y regex) con probador.
- Listas por etiqueta, lista blanca, ámbitos por sección de X, excepciones (perfil propio y publicación abierta).
- Estadísticas locales, exportación e importación validada de configuración, atajos de teclado.
- Popup con estado de la API, alta rápida y diagnóstico copiable.
- Documentación con capturas reales, guía de instalación ilustrada, descargo de responsabilidad y política de privacidad.

### Notas
- Incluye una **lista inicial pública** de unas 20 cuentas (solo nombre de usuario, etiquetas y estado; sin notas ni textos de terceros), editable y con canal para correcciones y retiros.
