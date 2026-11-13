# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

## [2.0.1] · 2026-11-12

- El producto se llama solo **MATATIGRE** (sin «V.1») en Chrome, la ventana emergente, las opciones, la bienvenida, los expedientes exportados y los documentos.
- Corregido: en el resumen del análisis aparecía el texto «null» bajo los hallazgos cuando había cinco o menos.

## [2.0.0] · 2026-11-12

Cambio grande: la extensión ya no incluye cuentas; se suscribe a listas publicadas en [matatigre-listas](https://github.com/LarexDev/matatigre-listas), que se actualizan solas.

### Listas
- Listas **sincronizadas** (solo lectura: se encienden, se apagan, se omiten cuentas solo para ti) y **propias** (control total), en una sola pestaña. Pantalla de bienvenida con las listas recomendadas.
- Añadir rápido desde la publicación, el popup o el menú contextual, siempre a una lista propia existente.
- Resumen de lo que cambia al actualizar una lista, y límites (5 000 cuentas por lista, 25 000 en total, 30 listas).
- Las cuentas se reconocen por identificador: un cambio de nombre de usuario no las pierde.

### Uso diario
- Pausar 10 minutos, 1 hora o 12 horas, con vuelta automática. Perfiles de un clic: Estricto, Moderado, Solo marcar.
- «Por qué se ocultó» en frases (`Citando a @x`, `Respondiendo a @x`), con «Siempre mostrar» en un clic.
- Aviso si X cambia y el filtro deja de reconocer publicaciones; aviso para recargar tras actualizar; recordatorio de copia de seguridad.
- Modo oscuro (Auto, Claro, Oscuro), diálogos propios con «Deshacer» y lenguaje unificado ([guía](docs/LENGUAJE.md)).

### Modo analista (opcional, apagado por defecto)
- Registro local de lo que toca a tus listas y pestaña Análisis: resumen con hallazgos y su fiabilidad, mapa de burbujas por comunidad, narrativas con palabras clave, temas definidos por ti, cuentas afines o sincronizadas, y expedientes con evidencia anclada.
- La sincronía se contrasta con el azar solo dentro de los periodos con actividad observada; cada hallazgo muestra lo observado frente a lo esperado. Nunca etiqueta a nadie ni afirma intención.

### Migración desde la 1.x
- Al actualizar se abre la bienvenida; tus cuentas siguen funcionando hasta que te suscribas. Lo que añadiste o editaste se conserva.

### Privacidad
- La única petición de red es la descarga del catálogo y de las listas que sigues. Ver [PRIVACY.md](PRIVACY.md).

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
