# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

## [2.0.0] · 2026-11-12

### Cambiado
- **Análisis fiable con datos reales.** El modelo nulo de la sincronía ya no baraja las horas por todo el reloj sino solo dentro de los periodos en que hubo actividad observada (antes, el horario en que navegas podía parecer coordinación). Cada hallazgo muestra cuántas coincidencias se observaron frente a cuántas serían de esperar por azar, el resumen avisa si los datos son escasos, y *Cómo de fiable es este análisis con tus datos* pasa el mismo detector por horas barajadas (debe encontrar ≈ 0) y muestra la distribución de los valores p.
- **Pestaña Análisis rehecha:** seis secciones (Resumen, Mapa, Narrativas, Temas, Cuentas, Expedientes), panel lateral de detalle, mapa interactivo con Cytoscape.js (búsqueda, filtros, reorganizar, imagen) y gráficos con Apache ECharts (con modo oscuro). Las dos librerías van dentro de la extensión.
- **Modo analista** (apagado por defecto): sin él no hay pestaña Análisis ni registro. Quien ya tenía el registro encendido lo conserva.
- **Mapa en burbujas** (inspirado en los mapas de burbujas y de transacciones): las comunidades forman racimos con su halo y nombre, el tamaño es la atención recibida, el aro grueso marca las cuentas de tus listas y por defecto solo se dibujan la sincronía y las relaciones más fuertes (el resto aparece al señalar una cuenta o con «Todas»). Se puede alternar con la red de relaciones por fuerzas, y pulsar una comunidad abre su ficha.
- Corregido: en *Cuentas más relevantes* la columna «Comunidad» mostraba «[object HTMLSpanElement]».
- **Palabras vacías fuera de los términos:** una lista amplia (artículos, preposiciones, pronombres, verbos y adverbios comunes, saludos y ruido de redes; también risas, números y alargamientos) deja de contar en «lo que distingue a una comunidad», en las palabras compartidas y en los picos simultáneos. Además, «lo que distingue a una comunidad» exige que la palabra sea al menos 3 veces más frecuente dentro que fuera (el tema de fondo, que aparece por igual en todas, ya no sale) y la lista incluye también muletillas y adjetivos vagos (igual, general, bueno, verdad…). Cada narrativa muestra además sus **palabras clave** (las que más se repiten en ella y menos en el resto del registro).
- **«Por qué se ocultó» en frases:** en lugar de «cita · «Lista»», el popup y la barra de una publicación dicen «Cita a esta cuenta · lista «X»», «Repost suyo», «Su publicación»…
- Los números del análisis usan coma decimal y la curva de cada narrativa se ajusta a lo que dura.
- **Gestión de listas y cuentas rehecha** (pestaña única *Listas*): a la izquierda *Todas las cuentas*, *Mis listas* y *Sincronizadas* (con candado); a la derecha, el detalle. Las listas **propias** son ahora entidades reales (se crean, renombran, exportan y eliminan; una lista vacía existe y se puede elegir) y las **sincronizadas** son de solo lectura: se pueden encender, cambiar de modo, **omitir cuentas solo para ti**, **copiar a una lista propia** o dejar de seguir. Cuentas y listas se buscan y filtran juntas, con aviso para las cuentas sin lista y la posibilidad de **deshacer** casi cualquier cambio.
- **Botón de añadir rápido**: corregido el fallo por el que no aparecían las listas ya creadas (solo se leían de las etiquetas de las cuentas). Ahora solo ofrece **listas propias existentes**: ya no crea listas (eso se hace en *Opciones → Listas*), recuerda la última usada y, si no hay ninguna, lleva a crearla. El popup y el menú del navegador siguen la misma regla.
- **Modo oscuro**: sistema de diseño común para popup, opciones y bienvenida con colores definidos una vez, controles nativos (números, fechas, selectores, barras) que ahora también se oscurecen, y selector *Auto / Claro / Oscuro* en las opciones.
- **Revisión de interfaz**: diálogos y avisos propios en lugar de los del navegador (con *Deshacer*), pestañas con teclado y enlaces directos, estados vacíos con una acción, *Datos* agrupado, «Lista blanca» pasa a llamarse *Siempre mostrar* y se corrige que algunos elementos ocultos seguían a la vista.

### Añadido
- **Lenguaje revisado** (guía en `docs/LENGUAJE.md`): una palabra por concepto (cuenta, nombre de usuario, ocultar, lista propia/sincronizada, registro de actividad), «Citando a @x», «Respondiendo a @x»… para el «por qué se ocultó», casillas del popup y de *Ajustes* que dicen de quién se habla («Quienes las citan», «Lo que repostean»), apartados renombrados para que no se repitan («Cuándo no ocultar» frente a la pestaña «Siempre mostrar»; *Datos* pasa a *Copia y datos*), niveles con palabras en lugar de «E1», y el análisis, que es lo avanzado, al final de las pestañas. `npm run check` vigila el vocabulario.
- **Pausar un tiempo** desde el popup (10 minutos, 1 hora o 12 horas): el filtrado se reanuda solo, también si cierras el navegador; encenderlo a mano cancela la pausa.
- **Perfiles de un clic** en *Ajustes*: *Estricto* (oculta también respuestas y menciones), *Moderado* (lo recomendado) y *Solo marcar* (resalta sin ocultar); si cambias algo a mano se indica «Personalizado».
- **«Cómo leer este análisis»** en el Resumen: qué significan los niveles, *q*, «observado frente a esperado», los datos escasos, las comunidades y «afín» frente a «sincronizada».
- **Revisión estática** (`npm run check`, también dentro de `npm test`): comprueba que todo el JavaScript compila y que cada elemento que un script pide existe en su página.
- **Actividad simultánea entre comunidades**: comunidades distintas, aunque hablen de cosas distintas, que suben su actividad a la vez más de lo esperable (control de falsos descubrimientos y descarte de acontecimientos generales), con el vocabulario compartido en esos picos.
- **Temas definidos por ti** (palabras, prefijos y frases): actividad, reparto por comunidad, quién entra primero; y palabras que usan varias comunidades a la vez.
- **Candidatas externas**: cuentas que interactúan a menudo con tus listas, como *afín* (no indica coordinación) o *sincronizada*.
- **Hechos externos sobre la curva de las narrativas**, con la distancia en el tiempo (sin afirmar causa), y alta de hechos desde el detalle de la narrativa.
- **Avisos**: «!» en el icono y en el popup cuando X cambia y el filtro no reconoce las publicaciones; aviso para recargar la página tras actualizar la extensión; recordatorio de copia de seguridad (con la fecha de la última).
- **«¿Por qué se ocultó?»**: la barra de una publicación colapsada o resaltada y *Ocultadas recientemente* (popup) dicen qué lista la motivó, con «Siempre mostrar» en un clic.
- **Resumen de cambios al actualizar una lista sincronizada** (cuentas añadidas y quitadas, y aviso de cambio grande) y **límites** (5 000 cuentas por lista, 25 000 en total, 30 listas) con mensajes claros.
- **Lista de verificación por cuenta (sin puntuación)**: para cada cuenta, cinco criterios con su estado (*cumple* con evidencia, *no cumple* o *sin datos*) y el motivo: texto repetido en ventana corta, ráfagas de actividad, respuestas en masa a un mismo objetivo, amplificación concentrada y, solo como contexto, seguidores y antigüedad. Cuando una cuenta cumple al menos 3 de los 4 primeros y tiene una pareja con sincronía sostenida, el análisis la marca *revisar*: la etiqueta, si procede, la pones tú.
- **Sensibilidad a la ventana**: un par de cuentas solo alcanza *Coordinación sostenida* si su sincronía se mantiene con la mitad y con el doble de ventana; cada relación y cada núcleo indican en cuántas de las 3 se sostiene.
- **Comparación entre listas**: el mismo detector y los mismos umbrales para cada lista (proporción de sus cuentas activas con sincronía significativa), para comprobar que el criterio es simétrico.
- **Lo que distingue a cada comunidad** (hashtags, sitios y palabras con razón de probabilidades logarítmica y recuento crudo) y **robustez de cada narrativa** (qué queda sin las 3 cuentas más activas).
- **Análisis relacional**: el análisis parte de las cuentas de tus listas y reconstruye la red a su alrededor. Calcula las interacciones entre cuentas (respuestas, citas, reposts y menciones), la **sincronía entre pares de cuentas** (participar en los mismos eventos con horas muy próximas, con peso menor en eventos masivos) contrastada con un modelo de azar (desplazamiento circular de las horas de cada cuenta) y control de falsos descubrimientos (Benjamini–Hochberg), las **comunidades** (Louvain con consenso entre 10 ejecuciones: solo se conserva lo estable), la **relevancia** de cada cuenta (atención recibida, quién publica primero con intervalo de confianza, quién depende de una sola cuenta) y las **narrativas** (eventos unidos por compartir publicaciones: origen, arranque, concentración).
- **Hallazgos con pruebas**: núcleos de cuentas que publican en sincronía (niveles *Coincidencia*, *Coordinación probable* y *Coordinación sostenida*), cuentas externas que concentran su actividad en una cuenta de las listas, narrativas impulsadas por pocas cuentas y cuentas que conectan comunidades. Cada uno lleva las cuentas, las publicaciones de evidencia, los criterios numéricos, la estabilidad y las explicaciones alternativas, y se puede anclar a un expediente.
- **Mapa de relaciones**: grafo interactivo (zoom, arrastre, filtros, ficha por cuenta y por relación), curvas de propagación por narrativa, comunidades y cuentas más relevantes.
- **Cuentas vigiladas (ajuste, activo con el registro)**: las cuentas externas con 3 o más interacciones directas con tus listas pasan a registrarse también cuando publican, para ver cómo se mueven entre sí. Se recalcula desde el registro (caducan solas) y se desactiva en *Ajustes → Registro local*.
- **Análisis (radar de coordinación)**: nueva pestaña que, sobre el registro local, agrupa las observaciones en eventos (texto idéntico o casi idéntico, mismo enlace, mismo conjunto de hashtags, reposts de una misma publicación) y muestra cuántas cuentas entraron y cuándo, los indicadores que se cumplen, su estabilidad ante distintas ventanas de tiempo, la cobertura y las explicaciones alternativas (fuente común, tendencia, publicación con alcance, cobertura baja, misma búsqueda). Corre en un Worker y no puntúa ni etiqueta cuentas.
- **Expedientes**: anclar un evento guarda su evidencia (que no se borra con la retención), con eventos externos y notas del analista por separado; informe imprimible y paquete JSON con huella de integridad SHA-256 y cuentas seudonimizadas por defecto.
- **Reconocimiento por identificador**: la extensión aprende el id de usuario de las cuentas de tus listas; una cuenta que cambia de nombre se sigue filtrando y quien hereda ese nombre no se oculta por error. Las listas pueden traer el id (`accounts[].id`, opcional).
- **Registro local (opcional, apagado por defecto)**: guarda en tu navegador lo que publican o repostean las cuentas de tus listas y lo que otras cuentas les responden, citan, repostean o mencionan (hora, contadores, enlaces, hashtags, menciones y texto durante N días), incluido lo que el modo *Ocultar* te esconde. Nada más. Detecta nombres de usuario que cambian o que pasan a otra persona. Se activa en *Ajustes*, se borra en *Datos* y no sale de tu equipo.
- **Señales por cuenta**: el análisis resume, para cada cuenta, cuatro señales de comportamiento coordinado alrededor de tus listas (texto sincronizado, reposts sincronizados, respuestas repetidas al mismo objetivo, amplificación concentrada) y las cuentas que más interactúan con ellas, con la evidencia a la vista y la posibilidad de añadirlas a una lista. Sin puntuaciones ni etiquetas.
- **Sondeo del esquema de X**: *Copiar informe para soporte* incluye ahora las rutas de campos que X entrega (sin valores), para ajustar la captura.

### Cambiado (importante)
- **La extensión ya no incluye cuentas.** Ahora te suscribes a **listas** publicadas en un repositorio de datos aparte
  ([matatigre-listas](https://github.com/LarexDev/matatigre-listas)). Se descargan al aceptar la bienvenida y se actualizan solas cada 12 horas,
  sin necesidad de reinstalar la extensión. Si una descarga falla, se usa la última copia buena.
- **Capas.** Cada lista es de solo lectura y se reemplaza entera al actualizarse. Encima van tus cuentas propias, las cuentas que apagues para ti, la lista blanca y los
  interruptores por lista. Una cuenta retirada de una lista deja de filtrarse para todos.
- **Privacidad:** la extensión hace ahora una petición de red (el catálogo y las listas a las que te suscribes). Ver [PRIVACY.md](PRIVACY.md) y el [descargo](DISCLAIMER.md). Nuevo permiso: `alarms`.

### Añadido
- **Pantalla de bienvenida** al instalar: catálogo de listas con las recomendadas ya marcadas y un botón *Empezar*.
- *Opciones → Listas*: tus listas, *Actualizar*, *Más listas*, *Dejar de seguir* y **añadir una lista por URL**.
- Las cuentas de listas suscritas aparecen en *Opciones → Cuentas* como filas de solo lectura que se pueden apagar solo para ti.
- Exportar incluye las suscripciones; al importar, solo se aceptan ids del catálogo (nunca URLs de un archivo ajeno).

### Migración desde la 1.x
- Al actualizar se abre la bienvenida. Tus cuentas **siguen funcionando** hasta que decidas. Si te suscribes, las cuentas de la lista inicial que no habías tocado pasan a venir de la suscripción;
  lo que añadiste o editaste se conserva. Los interruptores de lista que ya tenías se respetan.
- *Fusionar lista inicial* desaparece de *Opciones → Datos*; solo queda *Fusionar lista local* para quien compile la extensión con su propio `accounts.local.json`.

### Interfaz
- Textos más sencillos en el popup, la bienvenida y las opciones. *Copiar diagnóstico* pasa del popup a *Opciones → Datos → Copiar informe para soporte*.

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
