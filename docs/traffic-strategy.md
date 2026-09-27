# Trafic pour un écran allumé toute la journée

La régulation et une première évolution automatique des infrastructures sont implémentées. L’évolution est locale au navigateur, dans `conf-city-mobility-v1` : deux utilisateurs peuvent conserver des villes différentes. Seules les constructions achevées et les choix d’ingress sont persistés ; les véhicules et les chantiers en cours repartent à l’ouverture.

## Problème initial

Avant la correction, deux boucles opposées de 48 unités à 0,3 voiture/s chacune atteignaient 80 voitures en cinq minutes, dont 46 arrêtées. Cinq minutes après coupure des arrivées, les 80 voitures étaient encore présentes, dont 44 arrêtées. Les boucles ne terminaient jamais leurs trajets, les voitures suivant une file n’avaient pas de délai de retrait, et les villes et ponts utilisaient des simulations distinctes.

## Régulation appliquée

- Une simulation commune pour toutes les villes et les ponts. Index spatial commun, prise en compte de la hauteur, identifiants stables et priorité déterministe entre véhicules munis d’un jeton d’attente.
- Un ou deux tours par véhicule d’ambiance, au maximum 120 secondes. Les autres trajets sortent à destination, avec une limite entre 120 et 300 secondes selon leur longueur.
- Une voiture immobilisée plus de 20 secondes peut se retirer progressivement sur 1,5 seconde. Au plus un nouveau retrait de dépannage par seconde pour tout le réseau. Les retraits normaux et de secours sont comptés séparément. L’ancien passage forcé qui ignorait les priorités a été supprimé.
- Budget de population calculé par échantillonnage et déduplication des voies, avec une cible visuelle de 35 % de leur capacité estimée. Limite absolue de 240 voitures et 60 camions pour tout le monde affiché.
- Arrivées lissées sur cinq secondes, refusées lorsque le budget ou l’espace disponible est épuisé. Aucune file de demandes différées à rejouer.
- La télémétrie absente, inconnue, indisponible ou vieille de 30 secondes ne produit plus de trafic de service. Les petites boucles d’ambiance restent décoratives ; leur intensité suit le CPU de l’hôte lorsqu’il est disponible.
- Une évolution des routes conserve les véhicules encore associés à un itinéraire : identité, âge et progression. Masquer une ville arrête ses entrées et retire sa circulation.

Le budget est une estimation géométrique, pas un modèle d’ingénierie routière. Le seuil de remplissage utilise encore ce budget global, mais la détection de bouchons est locale : au moins trois véhicules sous 0,35 unité/s dans un rayon de six unités, sur le même niveau. Une voiture d’un trajet interville arrêtée sur une île est attribuée à cette ville, pas au pont entier.

## Constructions automatiques

| Déclencheur | Chantier de 5 secondes | Effet |
| --- | --- | --- |
| Ville avec file locale persistante ou ≥ 80 % de son budget pendant 20 s | Élargissement des routes | Boulevards à deux voies par sens ; parcelles conservées |
| Pont avec file locale persistante ou ≥ 80 % de son budget pendant 20 s | Second tablier | Routes séparées en hauteur ; demande partagée, accès élargis dans les deux villes |
| Ville déjà élargie avec file persistante ou ≥ 80 % pendant 45 s | Métro aérien | Retrait de 45 % de la demande automobile, trains et passagers visibles |

Six secondes de retour à la normale effacent le temps d’observation ; une courte interruption suspend la progression. Un chantier commencé et une construction achevée restent acquis. Les délais suivent le temps réel observé, même à une image par seconde, et sont suspendus dans un onglet masqué ou après une longue période non observée. Le panneau **City evolution** affiche la population, les chantiers et les derniers événements. **Reset local construction** remet à zéro les constructions de ce monde, sans effacer les choix d’ingress.

Le panneau affiche le compte à rebours dès l’observation du bouchon ; cliquer dessus cadre sa position. Une balise de chantier apparaît aussi sur l’axe concerné. Le second tablier reçoit une teinte distincte et élargit les accès des deux villes sans supprimer leurs métros existants.

## Ronds-points

Une réservation d’entrée reste attribuée jusqu’au dégagement de la sortie. La place en aval est vérifiée avant admission ; les voitures en attente restent à l’extérieur du rond-point et leurs trajectoires futures ne peuvent plus bloquer le véhicule admis. Un rond-point délivre autant de réservations que son anneau contient de véhicules (`ringCapacity` : circonférence / `RING_SPACING`, par voie) ; l’insertion elle-même est une fusion arbitrée par les sondes (priorité à l’anneau, puis suivi).

Les arrivées sont limitées à trois véhicules en approche par entrée physique, dédupliquée entre les itinéraires ; les véhicules d’ambiance n’apparaissent plus directement dans un rond-point. Une attente devant un rond-point qui continue de servir sa file ne provoque pas de retrait de secours. Ce retrait reste disponible si le rond-point lui-même cesse de progresser, et la durée de vie maximale des trajets reste bornée.

Régression reproduite sur quatre entrées saturées : auparavant 18 retraits de secours sur certaines graines. Six essais (trois graines, 30 et 60 Hz) de cinq minutes de charge puis vidange se terminent désormais sans retrait et sans arrêt prolongé sur l’anneau. Les tests vérifient aussi le refus d’entrer lorsque la sortie est occupée.

## Métro et ports

Le métro possède une boucle aérienne, trois stations et deux rames de deux voitures, avec arrêts en station. Les passagers parcourent le trottoir puis rejoignent la station ; leur nombre représente la demande détournée et reste limité à 24 par ville, 160 au total. C’est une représentation agrégée : une voiture n’est pas suivie individuellement jusqu’à sa conversion en passager.

Un service devient ingress depuis sa fiche (**Internet ingress**), avec l’étiquette Swarm `confcity.ingress` (voir `swarm-labels.md`), ou avec `"ingress": true` dans son nœud JSON :

```json
{ "id": "gateway", "type": "app", "label": "API Gateway", "links": ["api"], "ingress": true }
```

Les choix faits dans l’interface sont prioritaires et persistés localement, devant l’étiquette du fournisseur puis le JSON.

Un service ingress **devient** le port : il n’y a plus de quai ajouté à côté de lui. Le layout le retire du bloc de ville — donc de l’enveloppe qui définit le littoral, sans quoi la côte serait poussée devant lui — et le repose sur le rivage, tourné vers le large, si une voie maritime droite dégagée est trouvée. Les routes de mer sont vérifiées contre les contours de toutes les îles ; sans façade dégagée, le service reste un bâtiment ordinaire. Le port se retrouve hors du périphérique et reçoit une avenue jusqu’à lui, comme tout bâtiment isolé. Plusieurs ingress d’une même île partagent un quai et reçoivent chacun leur poste à quai.

Basculer la case relance donc le layout complet : les routes sont reconstruites et les pools de trafic vidés, les véhicules disparaissent en cours de trajet. C’est une action utilisateur délibérée et rare, contrairement aux instantanés du proxy toutes les cinq secondes, qui eux sont protégés.

Le quai et le cargo sont dessinés par une géométrie procédurale à couleurs de sommets tant que `PORT_ASSETS` (`domain/nodeStyle.ts`) ne pointe pas vers des GLB : portiques, conteneurs et hangar pour le quai, coque, château et pont chargé pour le navire.

Les bateaux arrivent de l’extérieur selon le `netRxKbps` des ingress actifs. Chaque traversée dure une minute, puis le bateau décharge et disparaît. La flotte est plafonnée à 24 bateaux, dont trois par poste à quai. Un bateau vise le poste du service dont le RX l’a fait naître. Sans débit reçu frais, aucune nouvelle arrivée. Le RX peut inclure du trafic interne : marquer un ingress indique la sémantique attendue mais ne transforme pas cette métrique en mesure exacte du trafic Internet.

## Vérification

`bun test` couvre les distances de sécurité à 30 et 60 Hz, les boucles saturées et leur vidange, les retraits de voitures immobilisées, les étages de pont, la conservation des véhicules lors d’un changement de routes, le partage de demande du métro, les seuils de construction et les voies maritimes.

`bun scripts/traffic-soak.ts` lance deux scénarios déterministes de 24 heures chacun à 30 Hz (durées simulées). Deux boucles opposées reçoivent une demande excessive, avec voitures et camions. Vérifications : population sous le budget, âge maximal borné et vidange complète après coupure des arrivées. Le nombre d’heures peut être passé en argument pour une vérification courte.

Résultat des deux essais : pic de 24 véhicules pour un plafond de 24, puis zéro après coupure. Respectivement 43 694 et 43 590 trajets terminés, sans retrait de secours sur ces deux boucles. Le scénario du monde d’exemple chargé a également déclenché automatiquement un second tablier.

Le navigateur a aussi été vérifié avec télémétrie simulée : scène avec métro et pont supérieur, port, choix d’ingress, rechargement et remise à zéro persistante. Le test de boucle sur 24 heures ne prétend pas couvrir toutes les topologies ni mesurer le navigateur sur une journée réelle.

## Coût du rendu

Mode **Office** à 30 images/s par défaut, mode fluide à 60 ; simulation à pas fixe de 30 Hz, au maximum trois pas de rattrapage. L’onglet masqué ne rend plus et ne rattrape pas son absence. La flotte automobile commune utilise deux meshes instanciés ; les passagers, les trains et les bateaux partagent aussi leurs géométries. Pas de composant React par véhicule ni de nouvelle passe de réflexion pour l’eau.

La boucle utilise `frameloop="never"` et `advance` documentés dans les [hooks de React Three Fiber](https://r3f.docs.pmnd.rs/api/hooks). L’eau réutilise la carte côtière et la texture procédurale du projet, avec reflets de ciel calculés dans son matériau.

Le plafond d’images réduit le nombre de rendus lorsque la machine pouvait dépasser 30 fps. Il ne garantit pas un pourcentage universel d’économie CPU. Mesurer `?perf=1` puis le navigateur sur la machine du bureau avant d’envisager un Web Worker ou un niveau de détail supplémentaire. Un worker ne corrigerait pas à lui seul l’accumulation des voitures.

## Suivi des trajectoires

Voitures, camions et métros partagent une horloge à 30 Hz et le même échantillonnage en distance réelle 3D. Chaque voie routière est un chemin continu, partagé par le placement, les sondes et les contrôles de carrefour. Deux points espacés de la longueur du véhicule déterminent son cap et sa pente, sans roulis. Le métro conserve son circuit, ses trois stations et son cycle de 90 secondes ; chaque wagon suit le chemin avec un espacement de 0,8 unité entre centres.
