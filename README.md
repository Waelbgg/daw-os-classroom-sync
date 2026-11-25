# DAW OS — Classroom Sync

DAW OS — Classroom Sync reúne las tareas de Google Classroom en una base de datos de Notion mediante Google Apps Script. El proyecto nació de una necesidad concreta: el calendario académico dejó de estar disponible y revisar cada curso manualmente hacía fácil perder de vista fechas de entrega. La integración concentra las tareas en una sola vista de Notion, también accesible desde el móvil.

## Estado y evidencia

La sincronización real está instalada y se ejecuta automáticamente cada 15 minutos. En una ejecución registrada se consultaron **8 cursos y 80 tareas**: las 80 ya estaban sincronizadas y no requirieron cambios; no hubo tareas omitidas ni errores en ese ciclo.

Ese resultado confirma el funcionamiento de consulta, comparación y detección de registros existentes para ese conjunto de datos. Como no se detectaron cambios, esa ejecución no prueba por sí sola las ramas de creación y actualización. El proyecto conserva esos comportamientos en el código para mantener la base de Notion al día cuando Classroom cambie.

## Arquitectura

```text
Google Classroom API → Google Apps Script → Notion API → «Tareas y entregas»
```

Apps Script obtiene los cursos, las tareas y el estado de entrega visible para la cuenta autenticada. Después consulta Notion, identifica cada tarea con los IDs de curso y tarea de Classroom y crea o actualiza el registro correspondiente. La ejecución usa paginación, reintentos ante respuestas transitorias y bloqueo para evitar ejecuciones simultáneas. Un activador temporal mantiene la consulta periódica.

La base conserva los campos de seguimiento académico, incluida la fecha límite, la calificación, el estado de entrega, la entrega tardía, las notas y las propiedades personales que no gestiona la sincronización. La identificación de tareas se guarda en las notas para evitar duplicados.

## Archivos

- `Code.gs`: integración entre Classroom y Notion, consulta, comparación, creación, actualización y activador periódico.
- `appsscript.json`: servicios avanzados y permisos OAuth requeridos.
- `index.html`, `style.css`, `daw-demo.js` y `navigation.js`: ficha técnica y demostración interactiva local.
- `tests/classroom-sync.test.cjs`: comprobación local de que se omiten tareas sin entrega visible.

## Demo web

La demo ejecutada en el navegador es independiente de la integración real. Usa tareas ficticias y permite filtrar, simular una sincronización y consultar un registro de actividad. No inicia sesión ni llama a Classroom o Notion; no muestra datos académicos reales.

## Configuración de Apps Script

El proyecto utiliza el servicio avanzado de Google Classroom y una integración de Notion con acceso a la base «Tareas y entregas».

1. Crear un proyecto de Google Apps Script y copiar `Code.gs` y `appsscript.json`.
2. Habilitar Google Classroom API como servicio avanzado y en el proyecto de Google Cloud vinculado.
3. Guardar el token de Notion en Script Properties con la clave `NOTION_TOKEN`; el token no se almacena en este repositorio.
4. Compartir la base de Notion con la integración y comprobar que sus propiedades coinciden con el esquema usado por el script.
5. Ejecutar `instalarTriggerSincronizacion()` una vez para registrar la sincronización automática cada 15 minutos.

Los nombres de funciones y las instrucciones anteriores describen el código incluido. La instalación activa y las credenciales pertenecen al proyecto privado de Apps Script y no se publican aquí.

## Privacidad

El repositorio no contiene tokens ni credenciales. La integración accede a los cursos y las entregas visibles para la cuenta que la ejecuta y escribe en la base de Notion compartida con ella. La demo local utiliza únicamente datos de ejemplo.

## Evolución

La arquitectura de Apps Script puede ampliarse para enviar la información a otros servicios o añadir nuevos destinos. Esas conexiones son posibilidades futuras; la integración operativa documentada aquí conecta Google Classroom con Notion.

## Autoría

Proyecto personal de Wael Boutafah Jebari, estudiante de Desarrollo de Aplicaciones Web.
