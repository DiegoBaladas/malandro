const { crearMazo, mezclar } = require("./mazo.js");

// Poderes de las cartas (solo se activan al sacar del mazo y descartar directo)
const PODERES = { 7: "ver-propia", 8: "ver-ajena", 9: "cambiar" };

// Reparte una ronda nueva y devuelve las partes que cambian en cada ronda
function repartirRonda(partida, quienEmpieza) {
  const cantidad = partida.jugadores.length;
  const cantidadDeMazos = cantidad <= 4 ? 1 : 2;
  const mazo = mezclar(crearMazo(cantidadDeMazos));

  for (const jugador of partida.jugadores) {
    jugador.cartas = [];
  }
  // Se reparte de a una carta por jugador, 4 vueltas
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    for (const jugador of partida.jugadores) {
      jugador.cartas.push(mazo.pop());
    }
  }

  partida.mazo = mazo;
  partida.descarte = [mazo.pop()];
  partida.turno = quienEmpieza;
  partida.inicioRonda = quienEmpieza;
  partida.cartaEnMano = null;
  partida.poderPendiente = null;
  partida.cantó = null; // posicion de quien canto MALANDRO (null si nadie)
  partida.estado = "jugando";
}

// Crea una partida nueva a partir de los nombres y el limite de puntos
function crearPartida(nombres, limitePuntos) {
  if (nombres.length < 3 || nombres.length > 8) {
    throw new Error("Se necesitan entre 3 y 8 jugadores");
  }
  const limite = limitePuntos === undefined ? 100 : limitePuntos;
  if (!Number.isInteger(limite) || limite < 1) {
    throw new Error("El limite de puntos tiene que ser un numero entero positivo");
  }

  const partida = {
    jugadores: nombres.map((nombre) => ({ nombre: nombre, cartas: [], puntos: 0 })),
    limitePuntos: limite,
    ganadores: [],
  };
  repartirRonda(partida, 0);
  return partida;
}

// Si el mazo se quedo sin cartas, se mezcla el descarte (menos la de arriba)
function reponerMazoSiHaceFalta(partida) {
  if (partida.mazo.length > 0) return;
  if (partida.descarte.length < 2) {
    throw new Error("No quedan cartas para reponer el mazo");
  }
  const arriba = partida.descarte.pop();
  partida.mazo = mezclar(partida.descarte);
  partida.descarte = [arriba];
}

// Solo se puede jugar mientras la ronda esta en juego
function exigirJugando(partida) {
  if (partida.estado === "ronda-terminada") throw new Error("La ronda ya termino");
  if (partida.estado === "partida-terminada") throw new Error("La partida ya termino");
}

// Comprueba que la posicion elegida sea una carta que existe
function validarPosicion(jugador, posicion) {
  if (!Number.isInteger(posicion) || posicion < 0 || posicion >= jugador.cartas.length) {
    throw new Error("Posicion de carta invalida");
  }
}

// Comprueba que el jugador tenga pendiente justo ese poder
function exigirPoder(partida, poder) {
  if (!partida.poderPendiente) throw new Error("No tenes ningun poder para usar");
  if (partida.poderPendiente !== poder) throw new Error("Ese no es el poder que te toco");
}

// Comprueba que el numero de jugador elegido exista
function validarJugador(partida, indice) {
  if (!Number.isInteger(indice) || indice < 0 || indice >= partida.jugadores.length) {
    throw new Error("Jugador invalido");
  }
}

// Jugada 1: sacar una carta del mazo (queda "en mano" hasta que decida)
function sacarDelMazo(partida) {
  exigirJugando(partida);
  if (partida.cartaEnMano) throw new Error("Ya sacaste una carta, tenes que resolverla");
  reponerMazoSiHaceFalta(partida);
  partida.cartaEnMano = partida.mazo.pop();
  return partida.cartaEnMano;
}

// Jugada 2a: cambiar la carta que sacaste por una tuya (la tuya va al descarte)
function cambiarConMano(partida, posicion) {
  exigirJugando(partida);
  if (!partida.cartaEnMano) throw new Error("No sacaste ninguna carta del mazo");
  const jugador = partida.jugadores[partida.turno];
  validarPosicion(jugador, posicion);

  const vieja = jugador.cartas[posicion];
  jugador.cartas[posicion] = partida.cartaEnMano;
  partida.descarte.push(vieja);
  partida.cartaEnMano = null;
  return vieja; // la carta que se dio vuelta al descartarla
}

// Jugada 2b: descartar directo la carta que sacaste (aca se activan los poderes)
function descartarDeMano(partida) {
  exigirJugando(partida);
  if (!partida.cartaEnMano) throw new Error("No sacaste ninguna carta del mazo");
  const carta = partida.cartaEnMano;
  partida.descarte.push(carta);
  partida.cartaEnMano = null;
  const poder = PODERES[carta.valor] || null;
  partida.poderPendiente = poder;
  return { carta: carta, poder: poder };
}

// Jugada alternativa: levantar la de arriba del descarte y cambiarla por una tuya
function levantarDescarte(partida, posicion) {
  exigirJugando(partida);
  if (partida.cartaEnMano) throw new Error("Ya sacaste una carta, tenes que resolverla");
  const jugador = partida.jugadores[partida.turno];
  validarPosicion(jugador, posicion);

  const nueva = partida.descarte.pop();
  const vieja = jugador.cartas[posicion];
  jugador.cartas[posicion] = nueva;
  partida.descarte.push(vieja);
  return vieja;
}

// Poder del 7: ver una carta tuya
function verPropia(partida, posicion) {
  exigirJugando(partida);
  exigirPoder(partida, "ver-propia");
  const jugador = partida.jugadores[partida.turno];
  validarPosicion(jugador, posicion);
  partida.poderPendiente = null;
  return jugador.cartas[posicion];
}

// Poder del 8: ver una carta de otro jugador
function verAjena(partida, indiceJugador, posicion) {
  exigirJugando(partida);
  exigirPoder(partida, "ver-ajena");
  validarJugador(partida, indiceJugador);
  if (indiceJugador === partida.turno) throw new Error("Tenes que elegir a otro jugador");
  const otro = partida.jugadores[indiceJugador];
  validarPosicion(otro, posicion);
  partida.poderPendiente = null;
  return otro.cartas[posicion];
}

// Poder del 9: cambiar a ciegas una carta tuya por una de otro jugador
function cambiarACiegas(partida, posicionPropia, indiceJugador, posicionAjena) {
  exigirJugando(partida);
  exigirPoder(partida, "cambiar");
  validarJugador(partida, indiceJugador);
  if (indiceJugador === partida.turno) throw new Error("Tenes que elegir a otro jugador");
  const yo = partida.jugadores[partida.turno];
  const otro = partida.jugadores[indiceJugador];
  validarPosicion(yo, posicionPropia);
  validarPosicion(otro, posicionAjena);

  const temporal = yo.cartas[posicionPropia];
  yo.cartas[posicionPropia] = otro.cartas[posicionAjena];
  otro.cartas[posicionAjena] = temporal;
  partida.poderPendiente = null;
}

// Suma el valor de las cartas de un jugador
function sumarCartas(jugador) {
  let total = 0;
  for (const carta of jugador.cartas) total += carta.valor;
  return total;
}

// Cierra la ronda: da vuelta las cartas, reparte puntos y ve si termino la partida
function terminarRonda(partida) {
  const cantó = partida.cantó;
  const totales = partida.jugadores.map(sumarCartas);

  // El que canto necesita ser ESTRICTAMENTE menor que todos los demas
  let cantoGano = true;
  for (let i = 0; i < totales.length; i++) {
    if (i !== cantó && totales[i] <= totales[cantó]) cantoGano = false;
  }

  const sumados = totales.slice();
  sumados[cantó] = cantoGano ? 0 : totales[cantó] + 10;
  for (let i = 0; i < sumados.length; i++) {
    partida.jugadores[i].puntos += sumados[i];
  }

  const resultado = {
    cantó: cantó,
    cantoGano: cantoGano,
    totales: totales,
    sumados: sumados,
    cartas: partida.jugadores.map((j) => j.cartas.slice()),
    puntosAcumulados: partida.jugadores.map((j) => j.puntos),
    partidaTerminada: false,
    ganadores: [],
  };

  // Si alguien llego al limite, termina la partida: gana el que menos puntos tiene
  const alguienLlego = partida.jugadores.some((j) => j.puntos >= partida.limitePuntos);
  if (alguienLlego) {
    const minimo = Math.min(...partida.jugadores.map((j) => j.puntos));
    partida.ganadores = [];
    partida.jugadores.forEach((j, i) => {
      if (j.puntos === minimo) partida.ganadores.push(i);
    });
    partida.estado = "partida-terminada";
    resultado.partidaTerminada = true;
    resultado.ganadores = partida.ganadores.slice();
  } else {
    partida.estado = "ronda-terminada";
  }
  return resultado;
}

// Cantar MALANDRO: se hace al final de tu turno, antes de pasarlo
function cantarMalandro(partida) {
  exigirJugando(partida);
  if (partida.cartaEnMano) throw new Error("Primero tenes que resolver la carta que sacaste");
  if (partida.poderPendiente) throw new Error("Tenes que usar el poder antes de cantar");
  if (partida.cantó !== null) throw new Error("Ya se canto MALANDRO en esta ronda");
  partida.cantó = partida.turno;
  return pasarTurno(partida);
}

// Pasa el turno al siguiente jugador. Si volvio a quien canto, cierra la ronda.
// Devuelve el resultado de la ronda cuando termina, o null si sigue.
function pasarTurno(partida) {
  exigirJugando(partida);
  if (partida.cartaEnMano) throw new Error("Primero tenes que resolver la carta que sacaste");
  if (partida.poderPendiente) throw new Error("Tenes que usar el poder antes de pasar el turno");
  partida.turno = (partida.turno + 1) % partida.jugadores.length;
  if (partida.cantó !== null && partida.turno === partida.cantó) {
    return terminarRonda(partida);
  }
  return null;
}

// Empieza la ronda siguiente (el que arranca es el siguiente al que arranco la anterior)
function nuevaRonda(partida) {
  if (partida.estado === "partida-terminada") throw new Error("La partida ya termino");
  if (partida.estado !== "ronda-terminada") throw new Error("La ronda todavia no termino");
  const siguiente = (partida.inicioRonda + 1) % partida.jugadores.length;
  repartirRonda(partida, siguiente);
}

module.exports = {
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
};