// Los 4 palos de la baraja española
const PALOS = ["oro", "copa", "espada", "basto"];

// Crea el mazo: cada mazo tiene 48 cartas (1 al 12 en 4 palos) + 2 comodines = 50
function crearMazo(cantidadDeMazos) {
  const cartas = [];
  for (let m = 1; m <= cantidadDeMazos; m++) {
    for (const palo of PALOS) {
      for (let numero = 1; numero <= 12; numero++) {
        cartas.push({
          id: m + "-" + palo + "-" + numero,
          palo: palo,
          valor: numero,
        });
      }
    }
    cartas.push({ id: m + "-comodin-1", palo: "comodin", valor: 0 });
    cartas.push({ id: m + "-comodin-2", palo: "comodin", valor: 0 });
  }
  return cartas;
}

// Mezcla las cartas al azar (método Fisher-Yates)
function mezclar(cartas) {
  for (let i = cartas.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temporal = cartas[i];
    cartas[i] = cartas[j];
    cartas[j] = temporal;
  }
  return cartas;
}

module.exports = { crearMazo, mezclar };