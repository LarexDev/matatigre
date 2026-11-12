# Guía de lenguaje y arquitectura de la información

Para quien escribe o cambia textos de la extensión. La regla de fondo: **cada palabra de la pantalla debe significar una sola cosa y ser la que usaría la persona que la lee**, no la que usa el código.
`npm run check` revisa una parte (por ejemplo, que no se cuele «Handle» ni «(E1)»).

## Voz

- **Tú**, frases cortas, verbos de acción («Añadir», «Ocultar», «Exportar»). Sin disculpas ni adornos.
- **Qué pasa y qué hacer**: un error dice qué falló y cómo seguir («No se pudo conectar. Reintenta»), no el motivo técnico.
- **Sin jerga**: nada de handle, hash, worker, FDR, IndexedDB, «E1». Si hace falta una sigla (q), se explica en el sitio («Cómo leer este análisis»).
- **El análisis describe, no acusa**: «patrón compatible con comportamiento coordinado en una muestra parcial». Nunca «es una bodega», nunca intención, nunca «culpable».
- **Números** con coma decimal y dos decimales si son menores que 1 (0,02). Fechas y horas en español.
- Mayúscula solo al inicio y en nombres propios. Los menús y botones son verbos o sustantivos cortos.

## Vocabulario (una palabra por concepto)

| Concepto | Decimos | Evitamos |
| --- | --- | --- |
| Quien tiene cuenta en X | **cuenta** | perfil, usuario (salvo «@usuario» o «nombre de usuario») |
| El nombre `@algo` | **nombre de usuario** / **@usuario** | handle |
| Lo que escribe una cuenta | **publicación** | tuit, post, mensaje |
| Qué hace la extensión | **ocultar** (también **colapsar**, **resaltar**) | filtrar, quitar, borrar de la vista |
| La función completa | **filtrado** («Filtrado activo / pausado») | bloqueo, censura |
| Grupo de cuentas tuyo | **lista propia** | etiqueta, carpeta |
| Grupo de cuentas que sigues de otros | **lista sincronizada** (solo lectura) | suscrita, remota, importada |
| Una cuenta de una sincronizada que no quieres | **omitir** («omitida por ti») | desactivar, excluir |
| Cuentas que nunca se ocultan | **Siempre mostrar** | lista blanca, excepciones (reservado para «Cuándo no ocultar») |
| Datos que se guardan al analizar | **registro de actividad** (verbo: *registrar*) | log, base de datos, caché |
| Quien analiza | **modo analista** | experto, avanzado |
| Qué se ve en el mapa | **comunidad**, **sincronía**, **narrativa**, **tema** | clúster, red neuronal |
| Resultado del análisis | **hallazgo** | alerta, detección |

### Verbos que cambian datos

| Verbo | Cuándo | Ejemplo |
| --- | --- | --- |
| **Quitar** | Sacar algo de un conjunto sin destruirlo | «Quitar de esta lista» |
| **Eliminar** | Destruir un elemento que creaste | «Eliminar lista», «Eliminar regla» |
| **Borrar** | Vaciar datos acumulados | «Borrar registro», «Borrar expediente» |
| **Restablecer** | Volver a un estado inicial | «Restablecer todo», «Restablecer vista» |
| **Omitir / Restaurar** | Excluir cuentas de una lista sincronizada solo para ti | «Omitir», «Restaurar las omitidas» |

Casi todo lo que se quita puede **deshacerse** unos segundos: el aviso lo dice con el botón «Deshacer».

### Estados

Los interruptores se dicen como tales: una lista o una regla está **encendida** o **apagada**; una cuenta de una sincronizada está **filtrada** u **omitida**; el filtrado entero está **activo**, **pausado** o **pausado hasta las HH:MM**. No mezclar «desactivada», «inactiva» ni «parada».

## El «por qué se ocultó»

Una frase que dice qué ocurre con la cuenta de la lista, en gerundio cuando la publicación actúa sobre ella:

| Situación | Frase |
| --- | --- |
| La publica la cuenta | «Publicación de @x» |
| La repostea la cuenta | «Reposteado por @x» |
| Alguien la cita | «Citando a @x» |
| Alguien le responde | «Respondiendo a @x» |
| Alguien la menciona | «Mencionando a @x» |

Seguida de la lista que lo motiva («lista «Ruido»») o, si fue una regla, de la regla.

## Arquitectura de las opciones

Orden: primero lo que se usa a diario, después lo que se configura una vez, y al final lo avanzado.

1. **Listas** — qué cuentas se ocultan (propias y sincronizadas, y la vista de todas las cuentas).
2. **Reglas** — ocultar más allá de las listas (por nombre, texto, idioma…).
3. **Siempre mostrar** — la excepción a todo lo anterior.
4. **Ajustes** — *Perfil de filtrado* (un clic) → *Modo general* → *Qué se oculta* → *En qué partes de X* → *Modo analista* → *Cuándo no ocultar*.
5. **Estadísticas** — cuánto se ha ocultado.
6. **Copia y datos** — copia de seguridad, registro de actividad, soporte, empezar de cero.
7. **Análisis** (solo con el modo analista, separado al final) — Resumen · Mapa · Narrativas · Temas · Cuentas · Expedientes.

Cada pantalla responde a una pregunta: «¿qué oculto?», «¿qué excepciones hay?», «¿cómo funciona?», «¿qué se ha hecho?», «¿cómo no pierdo mis cosas?», «¿qué está pasando en la red?».

## Antes de añadir un texto

1. ¿Existe ya una palabra para esto en la tabla? Úsala.
2. ¿Lo entendería quien nunca ha visto el código? Si no, reescríbelo.
3. ¿Dice qué hacer, no solo qué falló?
4. ¿Afirma algo sobre una persona? Entonces describe lo observado, con su límite, y no lo que «es».
5. Añade las palabras nuevas a esta guía y, si son de ingeniería, a la lista de `tools/check.mjs`.
