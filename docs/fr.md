# Zones Roon (non officiel)

Connecteur non officiel, sans lien avec Roon Labs. Il parle à votre **Roon
Core** (Roon Server, Nucleus, ROCK, ou l'application Roon qui fait office de
Core) en réseau local, par l'API officielle des extensions Roon : sans compte,
sans cloud.

> Écrite d'après la documentation de l'API Roon : elle n'a **jamais été testée avec un vrai Roon Core**.
> Les retours sont bienvenus (issues GitHub de `LM1LC3N7/gladys-roon`).

Nécessite Gladys 5.3.0 ou plus récent (widget Musique).

## Ce que vous obtenez

Un appareil Gladys par **sortie Roon** (une pièce, une enceinte, un DAC),
avec :

- la lecture : lecture, pause, arrêt (widget Musique), précédent, suivant ;
- le morceau en cours : titre, artiste, album, pochette, durée et position ;
- l'aléatoire et la répétition (non, tout, un) ;
- le volume (0-100 % de la plage de la sortie) et la sourdine, quand Roon peut
  régler le volume de la sortie (pas pour un volume fixe ni pour des
  commandes +/- seulement) ;
- le nom de la zone où joue la sortie (par ex. « Salon + Cuisine » une fois
  regroupées).

Deux actions de scène : **regrouper deux sorties** (la zone garde la file
d'attente de la première) et **sortir une sortie de son groupe**.

## Mise en place

1. Saisissez l'**adresse** du Roon Core (donnez-lui une adresse fixe dans
   votre box), ou cliquez sur **Trouver le Roon Core** : Gladys interroge le
   réseau local, et quand un seul Core répond et qu'aucune adresse n'est
   saisie, son adresse est enregistrée. Le **port** est 9330 pour Roon 2
   (9100 pour les versions plus anciennes).
2. Dans Roon, ouvrez **Paramètres > Extensions** et cliquez sur **Activer** à
   côté de **Gladys (community)** (éditeur LM1LC3N7, une intégration de la
   communauté, pas de l'équipe Gladys Assistant). En attendant, le statut indique l'attente
   d'autorisation.
3. Ouvrez l'onglet **Découverte** et ajoutez les sorties voulues.

L'autorisation donnée par le Core est gardée dans le dossier `/data` de
l'intégration (jamais dans les journaux, jamais affichée). **Oublier
l'autorisation Roon** la supprime : il faut alors réactiver l'extension dans
Roon.

## Plafond de volume

**Plafond de volume (%)**, 50 par défaut : le volume le plus fort que Gladys
peut régler, en pourcentage de la plage de chaque sortie (100 : pas de
plafond). Un volume plus fort demandé par une scène ou le tableau de bord est
ramené au plafond, arrondi vers le bas au pas de la sortie, et jamais
au-dessus des limites réglées dans Roon. Couper la sourdine ramène d'abord le
volume sous le plafond s'il est au-dessus (et est refusé quand le volume de la
sortie est inconnu, tant qu'un plafond s'applique). Le volume changé dans Roon
lui-même n'est pas modifié.

## Les commandes et leurs réponses

Une commande réussit quand le Core l'a acceptée **et** que l'état renvoyé par
Roon la montre (lecture, pause, arrêt, volume, sourdine, aléatoire,
répétition, regroupement). Le déplacement dans le morceau, précédent et
suivant réussissent quand le Core les accepte. Une commande dont l'état est
déjà là (lecture sur une zone qui joue) réussit tout de suite ; un volume que
le Core rogne (une limite réglée dans Roon) répond « pas encore vue appliquée »
alors qu'il est réglé. Sinon la réponse dit ce qui
s'est passé : « rien envoyé », « envoyée, sans réponse (non confirmée) »,
« acceptée, pas encore vue appliquée (non confirmée) » ou « refusée par le
Roon Core ».

**La pause, l'arrêt, la sourdine et une baisse de volume ne sont pas retenus
par le plafond.** Ils ne sont refusés que si rien ne peut les recevoir :

- le Roon Core n'est pas connecté (ou pas encore autorisé) ;
- la sortie n'est pas dans Roon en ce moment (éteinte, renommée ou retirée) ;
- la valeur est invalide ;
- pour la sourdine et le volume : la sortie n'a pas de volume que Gladys peut
  régler ;
- plus de 256 requêtes attendent déjà le Core (un Core qui ne répond plus ;
  les autres commandes sont retenues dès 64).

Quand deux sorties ou plus portent le nom de l'appareil, la pause, l'arrêt, la
sourdine et une baisse de volume partent vers chacune d'elles (le volume
seulement vers celles qu'il baisse) ; la lecture, la remise du son, une hausse
de volume et les autres commandes sont refusées (quelle pièce serait-ce ?).
Une zone qui ne peut pas faire pause (une radio en direct) est arrêtée à la
place. Une remise du son qui attend son réglage de volume n'est pas envoyée
si une autre commande pour la même sortie a été cliquée entre-temps (une
sourdine cliquée après elle n'est jamais doublée).

## Bon à savoir

- **Identité** : une sortie est reconnue à son nom dans Roon, comme le fait
  Home Assistant (Roon peut changer ses identifiants internes). Renommer une
  sortie dans Roon donne un nouvel appareil dans Gladys et laisse l'ancien
  « injoignable » : les scènes qui l'utilisent ne marchent plus, sans erreur.
  **Noms permutés** (deux sorties qui échangent leurs noms dans Roon) : ils se
  voient aux identifiants de sortie vus en dernier pour chaque nom (gardés
  dans `/data`) ; le volume ne part jamais dans l'autre pièce. Jusqu'à une
  nouvelle Découverte (qui prend les nouveaux noms), l'appareil ne publie
  rien (son badge indique « injoignable »), la pause, l'arrêt, la sourdine et une baisse de volume vont à la pièce
  pour laquelle il a été créé, et les autres commandes sont refusées. Deux sorties de
  même nom sont laissées hors de Découverte et ne publient rien.
- **Réseau** : l'API des extensions Roon passe en `ws://` simple sur le réseau
  local : le jeton d'autorisation et les commandes y circulent en clair, comme
  pour toute extension Roon. Le jeton est envoyé à ce qui répond à l'adresse
  saisie avec l'identifiant du Core qui l'a donné.
- Les états arrivent en direct du Core (abonnement), rien n'est interrogé à
  intervalle. Après une perte du Core, rien n'est publié avant son retour ; le
  badge des appareils indique « injoignable » en attendant. La connexion est
  retentée après 5 s, puis 10 s, jusqu'à toutes les 2 minutes.
- La pochette est demandée au Core (400 px, 300 Ko au plus) quand Gladys
  l'affiche.
- Pas encore de listes de lecture, de bibliothèque ni de radios à parcourir
  (voir le TODO du dépôt).
