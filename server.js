const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const {
  crearPartida,
  sacarDelMazo,
  cambiarConMano,
  descartarDeMano,
  levantarDescarte,
  verPropia,
  verAjena,
  cambiarACiegas,
  cantarMalandro,
  pasarTurno,
  nuevaRonda,
} = require("./juego.js");

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

// Cuando alguien entra a la direccion principal, se le entrega la pagina
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Aca se guardan todas las salas abiertas, por codigo
const salas = Object.create(null);

// Cuanto tiempo se conserva una sala si se desconectan todos
const MINUTOS_DE_GRACIA = 5;

// Genera un codigo de 4 letras que no este en uso
function generarCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let codigo;
  do {
    codigo = "";
    for (let i = 0; i < 4; i++) {
      codigo += letras[Math.floor(Math.random() * letras.length)];
    }
  } while (salas[codigo]);
  return codigo;
}

function limpiarNombre(nombre) {
  return String(nombre === undefined ? "" : nombre).trim().slice(0, 15);
}

// La "llave" de cada jugador: 32 caracteres (numeros y letras a-f). Devuelve null si no es valida.
function tokenValido(token) {
  return typeof token === "string" && /^[a-f0-9]{32}$/.test(token) ? token : null;
}

// Lo que se les muestra a todos sobre la sala antes de empezar (nunca incluye cartas ni llaves)
function estadoPublico(sala) {
  return {
    codigo: sala.codigo,
    limite: sala.limite,
    anfitrion: sala.anfitrion,
    jugadores: sala.jugadores.map((j) => ({ id: j.id, nombre: j.nombre })),
    enJuego: sala.partida !== null,
  };
}

// Le manda a todos los de la sala el estado actualizado
function avisarSala(sala) {
  io.to(sala.codigo).emit("sala", estadoPublico(sala));
}

// Arma lo que UN jugador puede ver de la mesa. Nunca se incluyen cartas de la mano,
// salvo al terminar la ronda, cuando todas las cartas se dan vuelta para todos.
function vistaMesa(sala, indiceYo) {
  const p = sala.partida;
  const arriba = p.descarte[p.descarte.length - 1];
  const esMiTurno = sala.fase === "jugando" && p.turno === indiceYo;
  const hayCartaEnMano = p.cartaEnMano !== null;
  const turnoResuelto = esMiTurno && sala.accionHecha && !hayCartaEnMano && !p.poderPendiente;

  let resultado = null;
  if (sala.resultado) {
    const r = sala.resultado;
    resultado = {
      cantó: r.cantó,
      cantoGano: r.cantoGano,
      totales: r.totales,
      sumados: r.sumados,
      cartas: r.cartas.map((mano) => mano.map((c) => ({ palo: c.palo, valor: c.valor }))),
      puntosAcumulados: r.puntosAcumulados,
      partidaTerminada: r.partidaTerminada,
      ganadores: r.ganadores,
    };
  }

  return {
    yo: indiceYo,
    soyAnfitrion: sala.anfitrion === sala.jugadores[indiceYo].id,
    fase: sala.fase,
    turno: p.turno,
    cantó: p.cantó,
    limite: p.limitePuntos,
    mazo: p.mazo.length,
    descarte: { palo: arriba.palo, valor: arriba.valor },
    hayCartaEnMano: hayCartaEnMano,
    enMano:
      esMiTurno && hayCartaEnMano
        ? { palo: p.cartaEnMano.palo, valor: p.cartaEnMano.valor }
        : null,
    poder: p.poderPendiente,
    accionHecha: sala.accionHecha,
    puedoTerminar: turnoResuelto,
    puedoCantar: turnoResuelto && p.cantó === null,
    resultado: resultado,
    jugadores: p.jugadores.map((j, i) => ({
      nombre: j.nombre,
      puntos: j.puntos,
      cantidadCartas: j.cartas.length,
      listo: sala.listos[i],
      conectado: sala.jugadores[i].conectado,
    })),
  };
}

// Manda a cada jugador SU vista de la mesa
function enviarMesa(sala) {
  sala.jugadores.forEach((j, i) => {
    if (j.conectado) io.to(j.id).emit("mesa", vistaMesa(sala, i));
  });
}

// Se llama cuando la ronda termino: guarda el resultado y cambia la fase
function cerrarRonda(sala, resultado) {
  sala.resultado = resultado;
  sala.fase = resultado.partidaTerminada ? "partida-terminada" : "ronda-terminada";
  sala.accionHecha = false;
}

// Si el jugador de turno se desconecto, se descarta lo que tenia en mano y se pasa el turno
function saltarDesconectados(sala) {
  const p = sala.partida;
  let intentos = 0;
  while (
    sala.fase === "jugando" &&
    !sala.jugadores[p.turno].conectado &&
    intentos < sala.jugadores.length
  ) {
    if (p.cartaEnMano) {
      p.descarte.push(p.cartaEnMano);
      p.cartaEnMano = null;
    }
    p.poderPendiente = null;
    const resultado = pasarTurno(p);
    sala.accionHecha = false;
    if (resultado) cerrarRonda(sala, resultado);
    intentos++;
  }
}

// Si todos ya miraron sus cartas (o se fueron), empieza el juego de verdad
function revisarSiTodosListos(sala) {
  if (sala.fase === "mirando" && sala.listos.every(Boolean)) {
    sala.fase = "jugando";
    sala.accionHecha = false;
    saltarDesconectados(sala);
  }
}

// Si no queda nadie conectado, la sala se borra despues de unos minutos
function programarBorrado(sala) {
  clearTimeout(sala.borrarEn);
  sala.borrarEn = setTimeout(() => {
    if (salas[sala.codigo] === sala && sala.jugadores.every((j) => !j.conectado)) {
      delete salas[sala.codigo];
    }
  }, MINUTOS_DE_GRACIA * 60 * 1000);
}

// Registra una jugada de turno. Antes de ejecutarla comprueba que haya partida,
// que se este jugando y que sea el turno de quien la pide.
function registrarJugada(socket, evento, hacer) {
  socket.on(evento, (...argumentos) => {
    const respuesta = argumentos[argumentos.length - 1];
    if (typeof respuesta !== "function") return;
    const datos = argumentos.slice(0, -1);

    const sala = salas[socket.data.codigo];
    if (!sala || !sala.partida) return respuesta({ error: "No hay una partida en curso" });
    if (sala.fase !== "jugando") return respuesta({ error: "Ahora no se puede jugar" });
    const yo = sala.jugadores.findIndex((j) => j.id === socket.id);
    if (yo === -1 || sala.partida.turno !== yo) return respuesta({ error: "No es tu turno" });

    let extra;
    try {
      extra = hacer(sala, ...datos) || {};
    } catch (e) {
      return respuesta({ error: e.message });
    }
    respuesta(Object.assign({ ok: true }, extra));
    enviarMesa(sala);
  });
}

io.on("connection", (socket) => {
  // Crear una sala nueva
  socket.on("crear-sala", (datos, respuesta) => {
    if (typeof respuesta !== "function") return;
    if (socket.data.codigo) return respuesta({ error: "Ya estas en una sala" });
    const nombre = limpiarNombre(datos && datos.nombre);
    if (!nombre) return respuesta({ error: "Escribi tu nombre" });
    const token = tokenValido(datos && datos.token);
    if (!token) return respuesta({ error: "Recarga la pagina e intenta de nuevo" });

    const codigo = generarCodigo();
    const sala = {
      codigo: codigo,
      limite: 100,
      anfitrion: socket.id,
      jugadores: [{ id: socket.id, nombre: nombre, token: token, conectado: true }],
      partida: null,
      fase: null,
      listos: [],
      accionHecha: false,
      resultado: null,
      borrarEn: null,
    };
    salas[codigo] = sala;
    socket.data.codigo = codigo;
    socket.join(codigo);
    respuesta({ ok: true });
    avisarSala(sala);
  });

  // Entrar a una sala existente
  socket.on("unirse", (datos, respuesta) => {
    if (typeof respuesta !== "function") return;
    if (socket.data.codigo) return respuesta({ error: "Ya estas en una sala" });
    const nombre = limpiarNombre(datos && datos.nombre);
    if (!nombre) return respuesta({ error: "Escribi tu nombre" });
    const token = tokenValido(datos && datos.token);
    if (!token) return respuesta({ error: "Recarga la pagina e intenta de nuevo" });
    const codigo = String(datos && datos.codigo !== undefined ? datos.codigo : "")
      .trim()
      .toUpperCase();

    const sala = salas[codigo];
    if (!sala) return respuesta({ error: "No existe una sala con ese codigo" });
    if (sala.partida) return respuesta({ error: "La partida ya empezo" });
    if (sala.jugadores.length >= 8) return respuesta({ error: "La sala esta llena (maximo 8)" });
    if (sala.jugadores.some((j) => j.token === token)) {
      return respuesta({ error: "Ya estas en esa sala. Recarga la pagina" });
    }
    if (sala.jugadores.some((j) => j.nombre.toLowerCase() === nombre.toLowerCase())) {
      return respuesta({ error: "Ese nombre ya esta usado en la sala" });
    }

    sala.jugadores.push({ id: socket.id, nombre: nombre, token: token, conectado: true });
    socket.data.codigo = codigo;
    socket.join(codigo);
    respuesta({ ok: true });
    avisarSala(sala);
  });

  // Volver a la sala despues de recargar la pagina o de perder la conexion
  socket.on("reconectar", (datos, respuesta) => {
    if (typeof respuesta !== "function") return;
    if (socket.data.codigo) return respuesta({ error: "Ya estas en una sala" });
    const token = tokenValido(datos && datos.token);
    const codigo = String(datos && datos.codigo !== undefined ? datos.codigo : "")
      .trim()
      .toUpperCase();
    const sala = salas[codigo];
    if (!token || !sala) return respuesta({ error: "No se encontro tu partida" });

    const i = sala.jugadores.findIndex((j) => j.token === token);
    if (i === -1) return respuesta({ error: "No se encontro tu lugar en la sala" });

    const jugador = sala.jugadores[i];
    const viejoId = jugador.id;

    // Si la conexion vieja todavia figura abierta, se la cierra: manda la nueva
    if (jugador.conectado && viejoId !== socket.id) {
      const viejo = io.sockets.sockets.get(viejoId);
      if (viejo) {
        viejo.data.codigo = undefined;
        viejo.leave(codigo);
        viejo.disconnect(true);
      }
    }

    jugador.id = socket.id;
    jugador.conectado = true;
    if (sala.anfitrion === viejoId) sala.anfitrion = socket.id;
    clearTimeout(sala.borrarEn);
    socket.data.codigo = codigo;
    socket.join(codigo);
    respuesta({ ok: true });

    if (sala.partida) {
      saltarDesconectados(sala);
      enviarMesa(sala);
    } else {
      avisarSala(sala);
    }
  });

  // El anfitrion cambia el limite de puntos
  socket.on("cambiar-limite", (limite) => {
    const sala = salas[socket.data.codigo];
    if (!sala || sala.anfitrion !== socket.id || sala.partida) return;
    if (!Number.isInteger(limite) || limite < 10 || limite > 500) return;
    sala.limite = limite;
    avisarSala(sala);
  });

  // El anfitrion empieza la partida
  socket.on("empezar", (respuesta) => {
    if (typeof respuesta !== "function") return;
    const sala = salas[socket.data.codigo];
    if (!sala) return respuesta({ error: "No estas en una sala" });
    if (sala.anfitrion !== socket.id) return respuesta({ error: "Solo el anfitrion puede empezar" });
    if (sala.partida) return respuesta({ error: "La partida ya empezo" });
    if (sala.jugadores.length < 3) return respuesta({ error: "Se necesitan al menos 3 jugadores" });

    sala.partida = crearPartida(
      sala.jugadores.map((j) => j.nombre),
      sala.limite
    );
    sala.fase = "mirando";
    sala.listos = sala.jugadores.map(() => false);
    sala.accionHecha = false;
    sala.resultado = null;
    respuesta({ ok: true });
    enviarMesa(sala);
  });

  // Cuando termino la partida, el anfitrion vuelve a la sala de espera para jugar otra
  socket.on("nueva-partida", (respuesta) => {
    if (typeof respuesta !== "function") return;
    const sala = salas[socket.data.codigo];
    if (!sala || !sala.partida) return respuesta({ error: "No hay una partida en curso" });
    if (sala.anfitrion !== socket.id) {
      return respuesta({ error: "Solo el anfitrion puede empezar otra partida" });
    }
    if (sala.fase !== "partida-terminada") return respuesta({ error: "La partida todavia no termino" });

    // Los que se habian desconectado quedan afuera
    sala.jugadores = sala.jugadores.filter((j) => j.conectado);
    sala.partida = null;
    sala.fase = null;
    sala.listos = [];
    sala.accionHecha = false;
    sala.resultado = null;
    respuesta({ ok: true });
    avisarSala(sala);
  });

  // Mirar 2 de tus cartas al principio de cada ronda. Solo se puede una vez por jugador.
  socket.on("ver-inicial", (posiciones, respuesta) => {
    if (typeof respuesta !== "function") return;
    const sala = salas[socket.data.codigo];
    if (!sala || !sala.partida) return respuesta({ error: "No hay una partida en curso" });
    if (sala.fase !== "mirando") return respuesta({ error: "Ya paso el momento de mirar" });

    const yo = sala.jugadores.findIndex((j) => j.id === socket.id);
    if (yo === -1) return respuesta({ error: "No estas en la partida" });
    if (sala.listos[yo]) return respuesta({ error: "Ya miraste tus cartas" });

    const validas =
      Array.isArray(posiciones) &&
      posiciones.length === 2 &&
      posiciones[0] !== posiciones[1] &&
      posiciones.every((n) => Number.isInteger(n) && n >= 0 && n < 4);
    if (!validas) return respuesta({ error: "Elegi 2 cartas distintas" });

    const mano = sala.partida.jugadores[yo].cartas;
    const cartas = posiciones.map((n) => ({
      posicion: n,
      palo: mano[n].palo,
      valor: mano[n].valor,
    }));

    sala.listos[yo] = true;
    revisarSiTodosListos(sala);
    respuesta({ ok: true, cartas: cartas });
    enviarMesa(sala);
  });

  // ---------- Jugadas del turno ----------

  registrarJugada(socket, "sacar-mazo", (sala) => {
    if (sala.accionHecha) throw new Error("Ya jugaste, termina tu turno");
    sacarDelMazo(sala.partida);
  });

  registrarJugada(socket, "levantar-descarte", (sala, posicion) => {
    if (sala.accionHecha) throw new Error("Ya jugaste, termina tu turno");
    levantarDescarte(sala.partida, posicion);
    sala.accionHecha = true;
  });

  registrarJugada(socket, "cambiar-mano", (sala, posicion) => {
    cambiarConMano(sala.partida, posicion);
    sala.accionHecha = true;
  });

  registrarJugada(socket, "descartar-mano", (sala) => {
    descartarDeMano(sala.partida);
    sala.accionHecha = true;
  });

  registrarJugada(socket, "ver-propia", (sala, posicion) => {
    const c = verPropia(sala.partida, posicion);
    return { carta: { palo: c.palo, valor: c.valor } };
  });

  registrarJugada(socket, "ver-ajena", (sala, indiceJugador, posicion) => {
    const c = verAjena(sala.partida, indiceJugador, posicion);
    return { carta: { palo: c.palo, valor: c.valor } };
  });

  registrarJugada(socket, "cambiar-ciegas", (sala, propia, indiceJugador, ajena) => {
    cambiarACiegas(sala.partida, propia, indiceJugador, ajena);
  });

  registrarJugada(socket, "terminar-turno", (sala) => {
    if (!sala.accionHecha) throw new Error("Primero tenes que jugar una carta");
    const resultado = pasarTurno(sala.partida);
    sala.accionHecha = false;
    if (resultado) cerrarRonda(sala, resultado);
    saltarDesconectados(sala);
  });

  registrarJugada(socket, "cantar-malandro", (sala) => {
    if (!sala.accionHecha) throw new Error("Primero tenes que jugar una carta");
    const resultado = cantarMalandro(sala.partida);
    sala.accionHecha = false;
    if (resultado) cerrarRonda(sala, resultado);
    saltarDesconectados(sala);
  });

  // Empezar la ronda siguiente (cualquier jugador de la sala puede pedirlo)
  socket.on("siguiente-ronda", (respuesta) => {
    if (typeof respuesta !== "function") return;
    const sala = salas[socket.data.codigo];
    if (!sala || !sala.partida) return respuesta({ error: "No hay una partida en curso" });
    if (sala.fase !== "ronda-terminada") return respuesta({ error: "Todavia no se puede empezar otra ronda" });
    if (!sala.jugadores.some((j) => j.id === socket.id)) return respuesta({ error: "No estas en la partida" });

    nuevaRonda(sala.partida);
    sala.fase = "mirando";
    sala.listos = sala.jugadores.map((j) => !j.conectado);
    sala.accionHecha = false;
    sala.resultado = null;
    revisarSiTodosListos(sala);
    respuesta({ ok: true });
    enviarMesa(sala);
  });

  // Cuando alguien se desconecta (cierra la pestaña, recarga, se le va internet...)
  socket.on("disconnect", () => {
    const sala = salas[socket.data.codigo];
    if (!sala) return;

    // Con la partida en marcha NO se lo saca de la lista: se lo marca como desconectado
    if (sala.partida) {
      const i = sala.jugadores.findIndex((j) => j.id === socket.id);
      if (i !== -1) {
        sala.jugadores[i].conectado = false;
        sala.listos[i] = true; // para que no trabe a los demas en la fase de mirar
        revisarSiTodosListos(sala);
      }
      // Si se fue el anfitrion, el rol pasa a otro jugador conectado
      if (sala.anfitrion === socket.id) {
        const otro = sala.jugadores.find((j) => j.conectado);
        if (otro) sala.anfitrion = otro.id;
      }
      if (sala.jugadores.every((j) => !j.conectado)) {
        programarBorrado(sala);
        return;
      }
      saltarDesconectados(sala);
      enviarMesa(sala);
      return;
    }

    // Antes de empezar, se lo saca de la lista
    sala.jugadores = sala.jugadores.filter((j) => j.id !== socket.id);
    if (sala.jugadores.length === 0) {
      delete salas[sala.codigo];
      return;
    }
    if (sala.anfitrion === socket.id) sala.anfitrion = sala.jugadores[0].id;
    avisarSala(sala);
  });
});

const PUERTO = process.env.PORT || 3000;
servidor.listen(PUERTO, () => {
  console.log("Servidor listo en http://localhost:" + PUERTO);
});