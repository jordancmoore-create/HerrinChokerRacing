/* units.js — fuel-pressure unit handling (PSI default ⇄ kPa) + target band.
   Raw data stays in kPa everywhere; convert only at display time. */
(function (global) {
  "use strict";
  const KPA_PER_PSI = 6.894757;          // 1 psi = 6.894757 kPa (exact)
  const KEY = "fuel-unit";
  const BAND_PSI = [48, 52];             // target fuel-pressure band (PSI)

  function fuelUnit() { return localStorage.getItem(KEY) === "kpa" ? "kpa" : "psi"; } // default PSI
  function setFuelUnit(u) { localStorage.setItem(KEY, u === "kpa" ? "kpa" : "psi"); }
  function toggleFuel() { const n = fuelUnit() === "psi" ? "kpa" : "psi"; setFuelUnit(n); return n; }
  function fuelLabel() { return fuelUnit() === "psi" ? "psi" : "kPa"; }

  function fuelFromKpa(kpa) { return fuelUnit() === "psi" ? kpa / KPA_PER_PSI : kpa; }
  function fuelBand() { return fuelUnit() === "psi" ? BAND_PSI.slice() : BAND_PSI.map(p => p * KPA_PER_PSI); }
  function fuelBandKpa() { return BAND_PSI.map(p => p * KPA_PER_PSI); }   // [330.95, 358.53]

  global.Units = { KPA_PER_PSI, BAND_PSI, fuelUnit, setFuelUnit, toggleFuel, fuelLabel, fuelFromKpa, fuelBand, fuelBandKpa };
})(window);
