const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const sourcePath = path.join(__dirname, "..", "Code.gs");
const source = fs.readFileSync(sourcePath, "utf8");
const created = [];
const logs = [];

const context = vm.createContext({
  Logger: { log: (message) => logs.push(String(message)) },
  Utilities: { sleep: () => {} }
});

vm.runInContext(source, context, { filename: sourcePath });

context.obtenerTokenNotion_ = () => "test-token";
context.listarTodosLosCursos_ = () => [
  { id: "course-1", name: "Módulo de prueba" }
];
context.listarTrabajosDelCurso_ = () => [
  { id: "assigned", title: "Tarea asignada" },
  { id: "not-assigned", title: "Tarea no asignada" }
];
context.obtenerEntregaAlumno_ = (_courseId, courseworkId) =>
  courseworkId === "assigned" ? { state: "NEW" } : null;
context.consultarTodasLasPaginasNotion_ = () => [];
context.crearPaginaNotion_ = (_token, _course, task) => {
  created.push(task.id);
  return { id: `page-${task.id}`, properties: {} };
};
context.actualizarPaginaNotion_ = () => {
  throw new Error("No debe actualizarse ninguna página en esta prueba.");
};

context.sincronizarClassroomConNotionConBloqueo_();

assert.deepEqual(created, ["assigned"]);
assert.equal(
  logs.some((line) => line.includes("Tarea omitida sin entrega visible")),
  true
);
assert.equal(
  logs.some((line) => line.includes("creadas: 1") && line.includes("omitidas: 1")),
  true
);

console.log("OK: las tareas sin entrega visible se omiten; solo se crea la tarea asignada.");
