// -----------------------------------------------------------------------------
// The texts users read in Gladys (connection status, configuration buttons,
// command errors), in English and French. Never a token, never a body of the
// Core: only names the code chose and the display names of the Core.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const ENABLE_EN =
  'in Roon, open Settings > Extensions and click Enable next to "Gladys (community)"';
const ENABLE_FR =
  'dans Roon, ouvrez Paramètres > Extensions et cliquez sur Activer à côté de « Gladys (community) »';

export const T = {
  notConfigured: both(
    'Type the address of the Roon Core in the configuration, or click "Find the Roon Core".',
    'Saisissez l’adresse du Roon Core dans la configuration, ou cliquez sur « Trouver le Roon Core ».',
  ),
  invalid: (keys) =>
    both(
      `Invalid value, fix it in the configuration: ${keys.join(', ')}.`,
      `Valeur invalide, à corriger dans la configuration : ${keys.join(', ')}.`,
    ),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys, tried again in ${seconds(wait)} s.`,
      `La configuration n’a pas pu être lue dans Gladys, nouvel essai dans ${seconds(wait)} s.`,
    ),
  storeUnreadable: (code) =>
    both(
      `The authorization kept in /data cannot be read (${code}): nothing is sent to the Roon Core. Click "Forget the Roon authorization", then enable the extension again in Roon.`,
      `L’autorisation gardée dans /data est illisible (${code}) : rien n’est envoyé au Roon Core. Cliquez sur « Oublier l’autorisation Roon », puis réactivez l’extension dans Roon.`,
    ),
  connecting: (address) =>
    both(`Connecting to the Roon Core at ${address}…`, `Connexion au Roon Core à ${address}…`),
  unreachable: (address, wait) =>
    both(
      `The Roon Core does not answer at ${address} (address, port, Core stopped?), tried again in ${seconds(wait)} s.`,
      `Le Roon Core ne répond pas à ${address} (adresse, port, Core arrêté ?), nouvel essai dans ${seconds(wait)} s.`,
    ),
  lost: (wait) =>
    both(
      `Connection to the Roon Core lost, tried again in ${seconds(wait)} s.`,
      `Connexion au Roon Core perdue, nouvel essai dans ${seconds(wait)} s.`,
    ),
  notRoon: (address, wait) =>
    both(
      `What answers at ${address} is not a Roon Core (check the port: 9330 for Roon 2, 9100 before), tried again in ${seconds(wait)} s.`,
      `Ce qui répond à ${address} n’est pas un Roon Core (vérifiez le port : 9330 pour Roon 2, 9100 avant), nouvel essai dans ${seconds(wait)} s.`,
    ),
  waiting: (core) =>
    both(
      `Connected to ${core}, waiting for the authorization: ${ENABLE_EN}.`,
      `Connecté à ${core}, en attente d’autorisation : ${ENABLE_FR}.`,
    ),
  disabled: (wait) =>
    both(
      `The extension was disabled in Roon; asked again in ${seconds(wait)} s: ${ENABLE_EN}.`,
      `L’extension a été désactivée dans Roon ; nouvelle demande dans ${seconds(wait)} s : ${ENABLE_FR}.`,
    ),
  connected: (core, outputs) =>
    both(`${core}: ${outputs} output(s).`, `${core} : ${outputs} sortie(s).`),
  tokenNotSaved: both(
    'The authorization could not be written to /data: after a restart, the extension will have to be enabled again in Roon.',
    'L’autorisation n’a pas pu être écrite dans /data : après un redémarrage, il faudra réactiver l’extension dans Roon.',
  ),
  // --- Buttons -------------------------------------------------------------
  findNone: both(
    'No Roon Core answered on the local network (is the Core started, on the same network as Gladys?). Type its address instead.',
    'Aucun Roon Core n’a répondu sur le réseau local (Core démarré, sur le même réseau que Gladys ?). Saisissez plutôt son adresse.',
  ),
  findFailed: both(
    'The search could not run through Gladys (network discovery unavailable). Type the address of the Core instead.',
    'La recherche n’a pas pu passer par Gladys (découverte réseau indisponible). Saisissez plutôt l’adresse du Core.',
  ),
  findBusy: both('A search is already running.', 'Une recherche est déjà en cours.'),
  findSaved: (core) =>
    both(
      `Found ${core}: its address is saved in the configuration.`,
      `Trouvé ${core} : son adresse est enregistrée dans la configuration.`,
    ),
  findList: (cores) =>
    both(
      `Roon Core(s) found, type the address of yours in the configuration: ${cores}.`,
      `Roon Core trouvé(s), saisissez l’adresse du vôtre dans la configuration : ${cores}.`,
    ),
  forgotten: both(
    'Authorization forgotten. Enable the extension again in Roon (Settings > Extensions) when asked.',
    'Autorisation oubliée. Réactivez l’extension dans Roon (Paramètres > Extensions) quand elle le demande.',
  ),
  forgetFailed: both(
    'The authorization could not be forgotten: /data cannot be written.',
    'L’autorisation n’a pas pu être oubliée : /data n’est pas inscriptible.',
  ),
  test: (status, maxVolume) => ({
    en: `${status.en}\nVolume cap: ${maxVolume} %`,
    fr: `${status.fr}\nPlafond de volume : ${maxVolume} %`,
  }),
};

/** The errors a command gives back to Gladys (logged, shown in the panel). */
export const E = {
  notConnected: 'Nothing sent: the Roon Core is not connected.',
  noOutput: 'Nothing sent: this output is not in Roon right now (off, renamed or removed).',
  twoOutputs:
    'Nothing sent: two Roon outputs have this name; rename one in Roon, then run a Discovery.',
  swapped:
    'Nothing sent: the names of Roon outputs were swapped; only pause, stop, mute and a lower volume go (to the room of this device). Run a Discovery to take the new names.',
  badValue: 'Nothing sent: invalid value.',
  unknownFeature: 'Nothing sent: this feature cannot be commanded.',
  noVolume: 'Nothing sent: this output has no volume Gladys can set.',
  volumeUnknown:
    'Nothing sent: the volume of this output is unknown, it is not unmuted above the cap.',
  cancelled: 'Not unmuted: a later command for this output came first.',
  notGroupable: 'Nothing sent: Roon says these outputs cannot be grouped.',
  sameOutput: 'Nothing sent: choose two different outputs.',
  noTrack: 'Nothing sent: nothing to seek in.',
  sentNoAnswer: 'Sent to the Roon Core, without an answer (not confirmed).',
  refused: (name) => `Refused by the Roon Core (${name}).`,
  notConfirmed: 'Accepted by the Roon Core, not yet seen applied (not confirmed).',
  busy: 'Nothing sent: too many commands waiting for the Roon Core.',
  late: 'Nothing sent: no time left for this command (the Roon Core answered slowly).',
};
