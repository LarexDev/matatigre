# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [1.2.0] · 2026-11-02

### Añadido
- La lista **Petristas** pasa de 30 a 124 cuentas (la lista inicial completa suma ahora 204).

### Corregido
- Al encender una lista que venía apagada (Petro y su gobierno, Petristas, Antipetristas), sus cuentas seguían sin activarse
  porque cada una venía marcada como desactivada. Ahora la lista inicial las trae activas y el interruptor de la lista decide.
  Al fusionar la lista inicial, las cuentas que no hayas editado adoptan este estado.

## [1.1.0] · 2026-11-02

### Añadido
- **Lista inicial ampliada a 110 cuentas en cinco listas**, para filtrar de forma más granular:
  *Abelardo y su gobierno* (26), *Abelardistas* (21), *Petro y su gobierno* (32), *Petristas* (30) y *Antipetristas* (2).
- Cada handle se comprobó abriendo el perfil en X. Las listas de Petro y Petristas vienen apagadas por defecto.

### Cambiado
- Una cuenta pasa de Abelardistas a Antipetristas y se retira otra cuyo handle ya no corresponde a la persona que se pretendía incluir.
- La lista *Abelardo y su entorno oficial* pasa a llamarse *Abelardo y su gobierno*.

### Nota para quien ya tenía instalada la 1.0.0
- *Opciones → Datos → Fusionar lista inicial* añade las cuentas nuevas y actualiza las listas de las que no hayas editado.
  Las cuentas que el nuevo listado retira no se borran solas: elimínalas a mano si quieres.

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
