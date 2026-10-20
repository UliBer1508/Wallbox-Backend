'use strict';
/**
 * Alexa-Bridge für die Keba-Wallboxen in Neukirchen
 *
 * Verbindet zwei Sinric-Pro-Geräte mit den Wallboxen:
 *   "Auto-Laden"     (Dimmable Switch) -> P30X privat: Ein/Aus + Ladestrom in Prozent
 *   "Gäste-Wallbox"  (Switch)          -> P30C Gäste:  nur Status, Befehle werden abgelehnt
 *
 * Die Wallbox-Objekte brauchen diese Methoden (BackendWallbox erfüllt sie):
 *   getStatus()        -> Promise<{ charging: boolean, powerW: number, ... }>
 *   setEnabled(bool)   -> Promise<void>      (nur P30X)
 *   setCurrent(amps)   -> Promise<void>      (nur P30X)
 */
const SinricPro = require('sinricpro').default;
const { SinricProDimSwitch, SinricProSwitch } = require('sinricpro/devices');

const MIN_AMPS = 6;

/** Prozent (0–100) -> Ampere, begrenzt auf MIN_AMPS..maxAmps (Grenze des Backends). */
function percentToAmps(percent, maxAmps = 16) {
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.max(MIN_AMPS, Math.min(maxAmps, Math.round((p * maxAmps) / 100)));
}

function ampsToPercent(amps, maxAmps = 16) {
  return Math.round((amps * 100) / maxAmps);
}

/**
 * @param {object} cfg
 * @param {string} cfg.appKey
 * @param {string} cfg.appSecret
 * @param {string} cfg.privateDeviceId  Sinric-Geräte-ID "Auto-Laden"
 * @param {string} [cfg.guestDeviceId]  Sinric-Geräte-ID "Gäste-Wallbox" (optional)
 * @param {number} [cfg.pollSeconds=30]
 * @param {number} [cfg.maxAmps=16]   Obergrenze, muss zu maxCurrentA in config.js des Backends passen
 * @param {object} wallboxes
 * @param {object} wallboxes.p30x  private Wallbox (steuerbar)
 * @param {object} [wallboxes.p30c] Gäste-Wallbox (nur lesen)
 * @param {function} [log=console.log]
 */
async function startAlexaBridge(cfg, { p30x, p30c }, log = console.log) {
  if (!cfg.appKey || !cfg.appSecret || !cfg.privateDeviceId) {
    throw new Error('SINRIC_APP_KEY, SINRIC_APP_SECRET und SINRIC_DEVICE_P30X müssen gesetzt sein');
  }

  const maxAmps = Number(cfg.maxAmps) || 16;
  let currentAmps = maxAmps;

  // --- Private Wallbox P30X ----------------------------------------------
  const autoLaden = SinricProDimSwitch(cfg.privateDeviceId);

  autoLaden.onPowerState(async (_id, state) => {
    try {
      await p30x.setEnabled(state);
      log(`[Alexa] Auto-Laden ${state ? 'EIN' : 'AUS'}`);
      return true;
    } catch (err) {
      log(`[Alexa] Fehler Auto-Laden ein/aus: ${err.message}`);
      return false;
    }
  });

  autoLaden.onPowerLevel(async (_id, level) => {
    try {
      const amps = percentToAmps(level, maxAmps);
      await p30x.setCurrent(amps);
      currentAmps = amps;
      log(`[Alexa] Ladestrom ${level} % -> ${amps} A`);
      return true;
    } catch (err) {
      log(`[Alexa] Fehler Ladestrom: ${err.message}`);
      return false;
    }
  });

  autoLaden.onAdjustPowerLevel(async (_id, delta) => {
    try {
      const amps = percentToAmps(ampsToPercent(currentAmps, maxAmps) + Number(delta || 0), maxAmps);
      await p30x.setCurrent(amps);
      currentAmps = amps;
      log(`[Alexa] Ladestrom angepasst (${delta} %) -> ${amps} A`);
      return true;
    } catch (err) {
      log(`[Alexa] Fehler Ladestrom anpassen: ${err.message}`);
      return false;
    }
  });

  SinricPro.add(autoLaden);

  // --- Gäste-Wallbox P30C (nur Status) -----------------------------------
  let gaesteWallbox = null;
  if (cfg.guestDeviceId && p30c) {
    gaesteWallbox = SinricProSwitch(cfg.guestDeviceId);
    // Bewusst fest verdrahtet: Gäste-Wallbox wird nie per Sprache geschaltet.
    gaesteWallbox.onPowerState(async () => {
      log('[Alexa] Befehl an Gäste-Wallbox abgelehnt (nur Status)');
      return false;
    });
    SinricPro.add(gaesteWallbox);
  }

  SinricPro.onConnected(() => log('[Alexa] Verbunden mit Sinric Pro'));
  SinricPro.onDisconnected(() => log('[Alexa] Verbindung zu Sinric Pro getrennt – neuer Versuch läuft'));

  await SinricPro.begin({ appKey: cfg.appKey, appSecret: cfg.appSecret });

  // --- Status regelmäßig melden ------------------------------------------
  let lastGuestCharging = null;
  const pollMs = Math.max(30, Number(cfg.pollSeconds) || 30) * 1000;

  const timer = setInterval(async () => {
    if (!gaesteWallbox) return;
    try {
      const s = await p30c.getStatus();
      if (s.charging !== lastGuestCharging) {
        await gaesteWallbox.sendPowerStateEvent(s.charging);
        lastGuestCharging = s.charging;
        log(`[Alexa] Gäste-Wallbox: ${s.charging ? 'lädt' : 'lädt nicht'} (${s.powerW} W)`);
      }
    } catch (err) {
      log(`[Alexa] Status Gäste-Wallbox nicht lesbar: ${err.message}`);
    }
  }, pollMs);

  return {
    stop() {
      clearInterval(timer);
      Promise.resolve().then(() => SinricPro.stop()).catch(() => { /* ignorieren */ });
    },
  };
}

module.exports = { startAlexaBridge, percentToAmps, ampsToPercent };
