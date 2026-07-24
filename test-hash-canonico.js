// Test unitario del hash canonico usado en la telemetria de caching (server.js:_hashCanonico).
// Sin framework: corre con `node test-hash-canonico.js`. Imprime OK/FAIL y setea exit code.
// Se REPLICA la funcion (no se importa server.js, que arranca el servidor entero) — debe quedar
// IDENTICA a la de server.js. Si cambia una, cambiar la otra.

const crypto = require('crypto');

function _hashCanonico(value) {
  try {
    function _canon(v) {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(_canon);
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = _canon(v[k]); });
      return out;
    }
    return crypto.createHash('sha256').update(JSON.stringify(_canon(value))).digest('hex');
  } catch (e) { return null; }
}

var fallos = 0;
function check(nombre, cond) {
  if (cond) { console.log('OK   - ' + nombre); }
  else { console.log('FAIL - ' + nombre); fallos++; }
}

// 1) Mismas claves en DISTINTO orden -> MISMO hash.
var a = { b: 1, a: 2, c: { y: 9, x: 8 } };
var b = { c: { x: 8, y: 9 }, a: 2, b: 1 };
check('mismas claves distinto orden => mismo hash', _hashCanonico(a) === _hashCanonico(b));

// 2) Orden dentro de arrays SI importa (el orden de un array es semantico, no se ordena).
var arr1 = [{ t: 1 }, { t: 2 }];
var arr2 = [{ t: 2 }, { t: 1 }];
check('arrays en distinto orden => distinto hash', _hashCanonico(arr1) !== _hashCanonico(arr2));

// 3) Array con objetos de claves desordenadas pero mismo orden de elementos => mismo hash.
var arrA = [{ p: 1, q: 2 }, { r: 3 }];
var arrB = [{ q: 2, p: 1 }, { r: 3 }];
check('array, claves internas desordenadas => mismo hash', _hashCanonico(arrA) === _hashCanonico(arrB));

// 4) Un cambio REAL de valor cambia el hash.
var c1 = { a: 1, b: 2 };
var c2 = { a: 1, b: 3 };
check('cambio de valor => distinto hash', _hashCanonico(c1) !== _hashCanonico(c2));

// 5) Una clave extra cambia el hash.
check('clave extra => distinto hash', _hashCanonico({ a: 1 }) !== _hashCanonico({ a: 1, z: 0 }));

// 6) String estable (systemStatic es un string): mismo string => mismo hash, distinto => distinto.
check('mismo string => mismo hash', _hashCanonico('hola mundo') === _hashCanonico('hola mundo'));
check('distinto string => distinto hash', _hashCanonico('hola mundo') !== _hashCanonico('hola  mundo'));

// 7) Determinismo: el hash es un sha256 en hex (64 chars).
check('formato sha256 hex (64 chars)', /^[0-9a-f]{64}$/.test(_hashCanonico({ a: 1 })));

if (fallos === 0) { console.log('\nTODO OK'); process.exit(0); }
else { console.log('\n' + fallos + ' FALLO(S)'); process.exit(1); }
