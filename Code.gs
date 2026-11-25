
/**
 * DAW OS - Classroom Sync
 * Sincroniza tareas visibles de Google Classroom con Notion.
 *
 * Incluye:
 * - Creación y actualización de tareas.
 * - Detección de duplicados.
 * - Estado real de entrega del alumno.
 * - Calificación asignada.
 * - Detección de entregas tardías.
 * - Conservación de propiedades personales de Notion.
 * - Paginación, reintentos y bloqueo de ejecuciones.
 */

const CONFIG = Object.freeze({
  NOTION_API_BASE: "https://api.notion.com/v1",
  NOTION_VERSION: "2026-03-11",
  NOTION_DATA_SOURCE_ID: "b04e8cc1-d72e-4604-854c-ffe187929a29",
  TOKEN_PROPERTY: "NOTION_TOKEN",
  PAGE_SIZE: 100,
  MAX_RETRIES: 3,
  WRITE_DELAY_MS: 350,
  MARKER_PREFIX: "[CLASSROOM_SYNC:",
  TEXT_CHUNK_SIZE: 1800,
  MAX_DESCRIPTION_LENGTH: 7000
});


/* =====================================================
   1. FUNCIONES PRINCIPALES
===================================================== */

function comprobarClassroom() {
  const cursos = listarTodosLosCursos_();

  Logger.log("Cursos encontrados: " + cursos.length);

  cursos.forEach(function(curso) {
    Logger.log(
      (curso.name || "Curso sin nombre") + " | " + curso.id
    );
  });
}


function listarTareas() {
  const cursos = listarTodosLosCursos_();

  cursos.forEach(function(curso) {
    Logger.log(
      "===== " + (curso.name || "Curso sin nombre") + " ====="
    );

    const tareas = listarTrabajosDelCurso_(curso.id);

    tareas.forEach(function(tarea) {
      Logger.log(
        "Tarea: " + (tarea.title || "Tarea sin título") +
        " | Entrega: " +
        fechaParaRegistro_(tarea.dueDate, tarea.dueTime)
      );
    });
  });
}


/**
 * Punto de entrada de la sincronización.
 */
function sincronizarClassroomConNotion() {
  const bloqueo = LockService.getScriptLock();

  if (!bloqueo.tryLock(30000)) {
    throw new Error(
      "Ya hay otra sincronización en curso."
    );
  }

  try {
    sincronizarClassroomConNotionConBloqueo_();
  } finally {
    bloqueo.releaseLock();
  }
}


/**
 * Sincronización principal.
 */
function sincronizarClassroomConNotionConBloqueo_() {
  const token = obtenerTokenNotion_();
  const cursos = listarTodosLosCursos_();
  const paginasNotion = consultarTodasLasPaginasNotion_(token);
  const paginasPorClave = indexarPaginasNotion_(paginasNotion);

  let tareasRevisadas = 0;
  let creadas = 0;
  let actualizadas = 0;
  let sinCambios = 0;
  let omitidas = 0;

  cursos.forEach(function(curso) {
    const tareas = listarTrabajosDelCurso_(curso.id);

    tareas.forEach(function(tarea) {
      if (!tarea.id) {
        omitidas++;
        return;
      }

      tareasRevisadas++;

      /*
       * Obtener la entrega del alumno autenticado.
       * Si la consulta falla, se detiene la ejecución
       * para evitar guardar datos incorrectos.
       */
      const entrega = obtenerEntregaAlumno_(
        curso.id,
        tarea.id
      );

      /*
       * Classroom puede devolver trabajos de curso que no están
       * asignados a la cuenta actual. Si no existe una entrega propia,
       * no crear ni actualizar una tarea en Notion: no hay evidencia
       * de que corresponda al alumno autenticado.
       */
      if (!entrega) {
        omitidas++;
        Logger.log(
          "Tarea omitida sin entrega visible para la cuenta actual: " +
          (curso.name || curso.id) + " | " +
          (tarea.title || tarea.id)
        );
        return;
      }

      const claveId = claveClassroom_(
        curso.id,
        tarea.id
      );

      const claveUrl = tarea.alternateLink
        ? clavePorUrl_(tarea.alternateLink)
        : null;

      const existente =
        paginasPorClave[claveId] ||
        (claveUrl && paginasPorClave[claveUrl]) ||
        null;

      // Crear tarea nueva.
      if (!existente) {
        const nuevaPagina = crearPaginaNotion_(
          token,
          curso,
          tarea,
          entrega
        );

        registrarPaginaEnIndice_(
          paginasPorClave,
          nuevaPagina,
          curso,
          tarea
        );

        creadas++;
        Utilities.sleep(CONFIG.WRITE_DELAY_MS);
        return;
      }

      // Comprobar si hay cambios.
      if (
        !necesitaActualizacion_(
          existente,
          curso,
          tarea,
          entrega
        )
      ) {
        sinCambios++;
        return;
      }

      // Actualizar página existente.
      actualizarPaginaNotion_(
        token,
        existente.id,
        curso,
        tarea,
        entrega
      );

      // Mantener actualizado el índice local.
      existente.properties = existente.properties || {};

      const propiedadesActualizadas =
        propiedadesDeClassroom_(
          curso,
          tarea,
          entrega
        );

      Object.keys(propiedadesActualizadas).forEach(
        function(nombre) {
          existente.properties[nombre] =
            propiedadesActualizadas[nombre];
        }
      );

      registrarPaginaEnIndice_(
        paginasPorClave,
        existente,
        curso,
        tarea
      );

      actualizadas++;
      Utilities.sleep(CONFIG.WRITE_DELAY_MS);
    });
  });

  Logger.log(
    "Sincronización completada. " +
    "Cursos: " + cursos.length +
    "; tareas revisadas: " + tareasRevisadas +
    "; creadas: " + creadas +
    "; actualizadas: " + actualizadas +
    "; sin cambios: " + sinCambios +
    "; omitidas: " + omitidas + "."
  );
}


/* =====================================================
   2. GOOGLE CLASSROOM
===================================================== */

function listarTodosLosCursos_() {
  const cursos = [];
  let pageToken = null;

  do {
    const opciones = {
      pageSize: CONFIG.PAGE_SIZE
    };

    if (pageToken) {
      opciones.pageToken = pageToken;
    }

    const respuesta =
      Classroom.Courses.list(opciones) || {};

    (respuesta.courses || []).forEach(function(curso) {
      cursos.push(curso);
    });

    pageToken = respuesta.nextPageToken || null;

  } while (pageToken);

  return cursos;
}


function listarTrabajosDelCurso_(courseId) {
  const tareas = [];
  let pageToken = null;

  do {
    const opciones = {
      pageSize: CONFIG.PAGE_SIZE
    };

    if (pageToken) {
      opciones.pageToken = pageToken;
    }

    const respuesta =
      Classroom.Courses.CourseWork.list(
        courseId,
        opciones
      ) || {};

    (respuesta.courseWork || []).forEach(function(tarea) {
      tareas.push(tarea);
    });

    pageToken = respuesta.nextPageToken || null;

  } while (pageToken);

  return tareas;
}


/**
 * Obtiene la entrega del alumno autenticado.
 * Utiliza userId: "me".
 */
function obtenerEntregaAlumno_(courseId, courseworkId) {
  const entregas = [];
  let pageToken = null;

  do {
    const opciones = {
      userId: "me",
      pageSize: CONFIG.PAGE_SIZE
    };

    if (pageToken) {
      opciones.pageToken = pageToken;
    }

    const respuesta =
      Classroom.Courses.CourseWork.StudentSubmissions.list(
        courseId,
        courseworkId,
        opciones
      ) || {};

    (respuesta.studentSubmissions || []).forEach(
      function(entrega) {
        entregas.push(entrega);
      }
    );

    pageToken = respuesta.nextPageToken || null;

  } while (pageToken);

  return entregas[0] || null;
}


/**
 * Traduce los datos de Classroom a propiedades Notion.
 */
function propiedadesEntregaNotion_(entrega) {
  if (!entrega) return null;

  const estados = {
    NEW: "Sin entregar",
    CREATED: "Borrador",
    TURNED_IN: "Entregada",
    RETURNED: "Devuelta",
    RECLAIMED_BY_STUDENT: "Recuperada",
    STUDENT_EDITED_AFTER_TURN_IN: "Entregada"
  };

  const estado = estados[entrega.state];

  if (!estado) {
    throw new Error(
      "Estado de entrega de Classroom no reconocido: " +
      entrega.state
    );
  }

  return {
    "Entrega Classroom": {
      select: {
        name: estado
      }
    },

    "Calificación Classroom": {
      number:
        typeof entrega.assignedGrade === "number"
          ? entrega.assignedGrade
          : null
    },

    "Entrega tardía": {
      checkbox: entrega.late === true
    }
  };
}


/* =====================================================
   3. NOTION: TOKEN Y CONSULTAS
===================================================== */

function obtenerTokenNotion_() {
  const valorGuardado = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.TOKEN_PROPERTY);

  if (!valorGuardado) {
    throw new Error(
      "Falta la propiedad de secuencia de comandos " +
      CONFIG.TOKEN_PROPERTY + "."
    );
  }

  let token = String(valorGuardado).trim();

  token = token.replace(/^Bearer\s+/i, "");

  const prefijos = token.match(/(?:ntn|secret)_/g) || [];

  if (
    !/^(?:ntn|secret)_[A-Za-z0-9_-]+$/.test(token) ||
    prefijos.length !== 1
  ) {
    throw new Error(
      CONFIG.TOKEN_PROPERTY +
      " debe contener un único token completo de Notion."
    );
  }

  return token;
}


function consultarTodasLasPaginasNotion_(token) {
  const paginas = [];
  let cursor = null;

  do {
    const cuerpo = {
      page_size: CONFIG.PAGE_SIZE,
      is_archived: false
    };

    if (cursor) {
      cuerpo.start_cursor = cursor;
    }

    const respuesta = notionRequest_(
      token,
      "post",
      "/data_sources/" +
        CONFIG.NOTION_DATA_SOURCE_ID +
        "/query",
      cuerpo
    );

    const estadoConsulta = respuesta.request_status || {};

    if (estadoConsulta.incomplete_reason) {
      throw new Error(
        "Notion no devolvió la consulta completa (" +
        estadoConsulta.incomplete_reason + ")."
      );
    }

    (respuesta.results || []).forEach(function(pagina) {
      paginas.push(pagina);
    });

    cursor = respuesta.has_more
      ? respuesta.next_cursor
      : null;

  } while (cursor);

  return paginas;
}


/* =====================================================
   4. ÍNDICE Y DETECCIÓN DE DUPLICADOS
===================================================== */

function indexarPaginasNotion_(paginas) {
  const indice = Object.create(null);

  paginas.forEach(function(pagina) {
    registrarClavesPagina_(indice, pagina);
  });

  return indice;
}


function registrarPaginaEnIndice_(
  indice,
  pagina,
  curso,
  tarea
) {
  if (pagina) {
    registrarClavesPagina_(indice, pagina);
  }

  const claveId = claveClassroom_(
    curso.id,
    tarea.id
  );

  if (pagina && !indice[claveId]) {
    indice[claveId] = pagina;
  }

  if (pagina && tarea.alternateLink) {
    const claveUrl = clavePorUrl_(
      tarea.alternateLink
    );

    if (!indice[claveUrl]) {
      indice[claveUrl] = pagina;
    }
  }
}


function registrarClavesPagina_(indice, pagina) {
  const propiedades = pagina.properties || {};

  const notas = textoDePropiedad_(
    propiedades["Notas"]
  );

  const claveId = claveDesdeMarcador_(notas);

  if (claveId && !indice[claveId]) {
    indice[claveId] = pagina;
  }

  const propiedadNotas = propiedades["Notas"];

  (
    propiedadNotas &&
    propiedadNotas.rich_text || []
  ).forEach(function(item) {
    const enlace = item.href ||
      (
        item.text &&
        item.text.link &&
        item.text.link.url
      ) ||
      null;

    if (enlace) {
      const claveEnlaceNotas = clavePorUrl_(enlace);

      if (!indice[claveEnlaceNotas]) {
        indice[claveEnlaceNotas] = pagina;
      }
    }
  });
}


function claveClassroom_(courseId, courseworkId) {
  return "id:" + courseId + ":" + courseworkId;
}


function clavePorUrl_(url) {
  return "url:" + url;
}


function claveDesdeMarcador_(notas) {
  const coincidencia = String(notas || "").match(
    /^\[CLASSROOM_SYNC:([^:\]]+):([^\]]+)\]/m
  );

  return coincidencia
    ? claveClassroom_(
        coincidencia[1],
        coincidencia[2]
      )
    : null;
}


/* =====================================================
   5. DETECCIÓN DE CAMBIOS
===================================================== */

function necesitaActualizacion_(
  pagina,
  curso,
  tarea,
  entrega
) {
  const propiedades = pagina.properties || {};

  const tituloActual = textoDePropiedad_(
    propiedades["Tarea"],
    "title"
  );

  const moduloActual = textoDePropiedad_(
    propiedades["Módulo"]
  );

  const fecha = propiedades["Fecha límite"];

  const fechaActual =
    fecha && fecha.date
      ? fecha.date.start || null
      : null;

  const cambiosGenerales =
    tituloActual !==
      (tarea.title || "Tarea sin título") ||

    moduloActual !==
      (curso.name || "Google Classroom") ||

    normalizarFechaParaComparar_(fechaActual) !==
      normalizarFechaParaComparar_(
        fechaNotion_(tarea.dueDate, tarea.dueTime)
      );

  if (cambiosGenerales) {
    return true;
  }

  // Si no existe respuesta de Classroom,
  // no modificar los datos de entrega de Notion.
  if (!entrega) {
    return false;
  }

  const nuevasPropiedades =
    propiedadesEntregaNotion_(entrega);

  const estadoActual =
    propiedades["Entrega Classroom"]?.select?.name ||
    null;

  const notaActual =
    propiedades["Calificación Classroom"]?.number ??
    null;

  const tardiaActual =
    propiedades["Entrega tardía"]?.checkbox === true;

  const estadoNuevo =
    nuevasPropiedades["Entrega Classroom"].select.name;

  const notaNueva =
    nuevasPropiedades["Calificación Classroom"].number;

  const tardiaNueva =
    nuevasPropiedades["Entrega tardía"].checkbox;

  return (
    estadoActual !== estadoNuevo ||
    notaActual !== notaNueva ||

    tardiaActual !== tardiaNueva
  );
}


/* =====================================================
   6. CREACIÓN Y ACTUALIZACIÓN DE PÁGINAS NOTION
===================================================== */

function crearPaginaNotion_(
  token,
  curso,
  tarea,
  entrega
) {
  const propiedades = propiedadesDeClassroom_(
    curso,
    tarea,
    entrega
  );

  propiedades["Notas"] = {
    rich_text: objetosNotasIniciales_(curso, tarea)
  };

  propiedades["Estado"] = {
    status: {
      name: "Pendiente"
    }
  };

  propiedades["Prioridad"] = {
    select: {
      name: "Media"
    }
  };

  propiedades["Tipo"] = {
    select: {
      name:
        tarea.workType === "ASSIGNMENT"
          ? "Entrega"
          : "Práctica"
    }
  };

  return notionRequest_(
    token,
    "post",
    "/pages",
    {
      parent: {
        type: "data_source_id",
        data_source_id: CONFIG.NOTION_DATA_SOURCE_ID
      },
      properties: propiedades
    }
  );
}


function actualizarPaginaNotion_(
  token,
  pageId,
  curso,
  tarea,
  entrega
) {
  return notionRequest_(
    token,
    "patch",
    "/pages/" + encodeURIComponent(pageId),
    {
      properties: propiedadesDeClassroom_(
        curso,
        tarea,
        entrega
      )
    }
  );
}


function propiedadesDeClassroom_(
  curso,
  tarea,
  entrega
) {
  const fecha = fechaNotion_(
    tarea.dueDate,
    tarea.dueTime
  );

  const propiedades = {
    "Tarea": {
      title: objetosTexto_(
        tarea.title || "Tarea sin título"
      )
    },

    "Módulo": {
      rich_text: objetosTexto_(
        curso.name || "Google Classroom"
      )
    },

    "Fecha límite": {
      date: fecha
        ? { start: fecha }
        : null
    }
  };

  if (entrega) {
    const datosEntrega =
      propiedadesEntregaNotion_(entrega);

    Object.assign(
      propiedades,
      datosEntrega
    );
  }

  return propiedades;
}


/* =====================================================
   7. NOTAS Y TEXTO
===================================================== */

function objetosNotasIniciales_(curso, tarea) {
  const marcador =
    CONFIG.MARKER_PREFIX +
    curso.id + ":" +
    tarea.id + "]";

  const partes = [
    marcador,
    "Curso de Classroom: " +
      (curso.name || curso.id),
    "Estado inicial en Classroom: " +
      (tarea.state || "desconocido")
  ];

  const descripcion = String(
    tarea.description || ""
  ).trim();

  const bloques = objetosTexto_(
    partes.join("\n\n")
  );

  if (descripcion) {
    bloques.push.apply(
      bloques,
      objetosTexto_(
        "\n\nDescripción:\n" +
        limitarTexto_(
          descripcion,
          CONFIG.MAX_DESCRIPTION_LENGTH
        )
      )
    );
  }

  if (tarea.alternateLink) {
    bloques.push({
      type: "text",
      text: {
        content: "\n\nAbrir tarea en Google Classroom",
        link: {
          url: tarea.alternateLink
        }
      }
    });
  }

  return bloques;
}


function objetosTexto_(valor) {
  const texto = String(
    valor == null ? "" : valor
  );

  const objetos = [];

  for (
    let inicio = 0;
    inicio < texto.length;
    inicio += CONFIG.TEXT_CHUNK_SIZE
  ) {
    objetos.push({
      type: "text",
      text: {
        content: texto.substring(
          inicio,
          inicio + CONFIG.TEXT_CHUNK_SIZE
        )
      }
    });
  }

  return objetos.length
    ? objetos
    : [
        {
          type: "text",
          text: {
            content: " "
          }
        }
      ];
}


function textoDePropiedad_(propiedad, tipo) {
  if (!propiedad) {
    return "";
  }

  const elementos = tipo === "title"
    ? propiedad.title || []
    : propiedad.rich_text || propiedad.text || [];

  return elementos.map(function(elemento) {
    if (elemento.plain_text != null) {
      return elemento.plain_text;
    }

    return elemento.text && elemento.text.content
      ? elemento.text.content
      : "";

  }).join("");
}


/* =====================================================
   8. FECHAS
===================================================== */

function fechaNotion_(dueDate, dueTime) {
  if (
    !dueDate ||
    !dueDate.year ||
    !dueDate.month ||
    !dueDate.day
  ) {
    return null;
  }

  const fecha =
    String(dueDate.year).padStart(4, "0") + "-" +
    String(dueDate.month).padStart(2, "0") + "-" +
    String(dueDate.day).padStart(2, "0");

  if (!dueTime) {
    return fecha;
  }

  const fechaConHora = new Date(
    Date.UTC(
      Number(dueDate.year),
      Number(dueDate.month) - 1,
      Number(dueDate.day),
      Number(dueTime.hours || 0),
      Number(dueTime.minutes || 0),
      Number(dueTime.seconds || 0),
      Math.floor(
        Number(dueTime.nanos || 0) / 1000000
      )
    )
  );

  return fechaConHora.toISOString();
}


function normalizarFechaParaComparar_(fecha) {
  if (!fecha) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return fecha;
  }

  const milisegundos = Date.parse(fecha);

  return isNaN(milisegundos)
    ? fecha
    : new Date(milisegundos).toISOString();
}


function fechaParaRegistro_(dueDate, dueTime) {
  return fechaNotion_(dueDate, dueTime) || "Sin fecha";
}


function limitarTexto_(texto, maximo) {
  const valor = String(texto || "");

  if (valor.length <= maximo) {
    return valor;
  }

  return valor.substring(0, maximo - 1) + "…";
}


/* =====================================================
   9. COMUNICACIÓN CON NOTION API
===================================================== */

function notionRequest_(
  token,
  metodo,
  ruta,
  cuerpo
) {
  const url = CONFIG.NOTION_API_BASE + ruta;

  const opciones = {
    method: metodo,
    contentType: "application/json",

    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": CONFIG.NOTION_VERSION
    },

    muteHttpExceptions: true
  };

  if (cuerpo !== undefined) {
    opciones.payload = JSON.stringify(cuerpo);
  }

  for (
    let intento = 0;
    intento <= CONFIG.MAX_RETRIES;
    intento++
  ) {
    const respuesta = UrlFetchApp.fetch(
      url,
      opciones
    );

    const codigo = respuesta.getResponseCode();
    const texto = respuesta.getContentText() || "";

    if (codigo >= 200 && codigo < 300) {
      if (!texto) {
        return {};
      }

      try {
        return JSON.parse(texto);
      } catch (error) {
        throw new Error(
          "Notion respondió HTTP " + codigo +
          " con un cuerpo que no es JSON válido."
        );
      }
    }

    const esErrorServidor =
      codigo === 500 ||
      codigo === 502 ||
      codigo === 503 ||
      codigo === 504 ||
      codigo === 529;

    const esConsulta =
      metodo === "post" &&
      /\/data_sources\/[^/]+\/query$/.test(ruta);

    const puedeReintentar =
      codigo === 429 ||
      (
        esErrorServidor &&
        (esConsulta || metodo === "patch")
      );

    if (
      puedeReintentar &&
      intento < CONFIG.MAX_RETRIES
    ) {
      Utilities.sleep(
        esperaReintento_(respuesta, intento)
      );

      continue;
    }

    const errorApi = parsearJsonSeguro_(texto);

    const codigoError =
      errorApi.code || "error_desconocido";

    const mensajeError =
      errorApi.message ||
      "Notion rechazó la solicitud.";

    throw new Error(
      "Notion HTTP " + codigo +
      " (" + codigoError + "): " +
      mensajeError
    );
  }

  throw new Error(
    "Notion no respondió después de varios intentos."
  );
}


function esperaReintento_(respuesta, intento) {
  const cabeceras =
    respuesta.getAllHeaders() || {};

  const retryAfter =
    cabeceras["Retry-After"] ||
    cabeceras["retry-after"] ||
    0;

  const segundos = Number(retryAfter);

  const espera = segundos > 0
    ? segundos * 1000
    : Math.pow(2, intento) * 1000;

  return Math.min(espera, 30000);
}


function parsearJsonSeguro_(texto) {
  try {
    return texto ? JSON.parse(texto) : {};
  } catch (error) {
    return {};
  }
}


/* =====================================================
   10. ACTIVADOR AUTOMÁTICO CADA 15 MINUTOS
===================================================== */

function instalarTriggerSincronizacion() {
  const funcion = "sincronizarClassroomConNotion";

  const existentes = ScriptApp
    .getProjectTriggers()
    .filter(function(trigger) {
      return trigger.getHandlerFunction() === funcion;
    });

  existentes.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp
    .newTrigger(funcion)
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log(
    "Sincronización automática instalada cada 15 minutos."
  );
}
