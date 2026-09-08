# Conf City — Visualisation d'infrastructure en ville 3D

## 1. Objectif du projet

Application de visualisation 3D representant une infrastructure informatique sous forme de **villes**.

- Frontend : **React + TypeScript + Three.js** (via Vite)
- Source : **graphe JSON statique**
- Concept cle : **1 serveur / cluster = 1 ville**
- Chaque ville contient des **briques** (applications, bases de donnees, etc.) reliees par des **liens**
- Les villes peuvent etre connectees entre elles par des **liens inter-villes**

Phase 1 (POC) — implementee :
- Visualisation statique avec modeles 3D (Kenney CC0)
- Layout deterministe sur grille
- Liens intra-ville et inter-villes
- Interactions : hover (tooltip), click (focus camera), toggle (montrer/masquer ville)

---

## 2. Modele conceptuel

```
World
 ├── City (serveur / cluster)
 │    ├── Node (app / db / cache / queue)
 │    └── Links intra-ville (dependances locales)
 └── Links inter-villes (flux entre serveurs)
```

| Concept | Signification |
|---------|---------------|
| World   | Ensemble de l'infrastructure |
| City    | Serveur, VM, cluster |
| Node    | Brique applicative (app, db, cache, queue) |
| Link    | Dependance / flux logique |

---

## 3. Format du graphe JSON (source de verite)

Le fichier d'entree est un objet JSON avec la structure suivante :

### 3.1 Schema complet

```json
{
  "cities": [
    {
      "id": "string",
      "name": "string",
      "description": "string (optionnel)",
      "nodes": [
        {
          "id": "string",
          "type": "app | db | cache | queue",
          "label": "string",
          "description": "string (optionnel)",
          "links": ["nodeId1", "nodeId2"]
        }
      ]
    }
  ],
  "links": [
    {
      "from": "cityId/nodeId",
      "to": "cityId/nodeId",
      "label": "string (optionnel)"
    }
  ]
}
```

### 3.2 Description des champs

#### `cities` (requis)

Tableau de villes. Chaque ville represente un serveur, une VM ou un cluster.

| Champ         | Type       | Requis | Description |
|---------------|------------|--------|-------------|
| `id`          | `string`   | oui    | Identifiant unique de la ville |
| `name`        | `string`   | oui    | Nom affiche dans la scene 3D |
| `description` | `string`   | non    | Description du serveur |
| `nodes`       | `Node[]`   | oui    | Briques applicatives de la ville |

#### `cities[].nodes` (requis)

Chaque noeud represente un service applicatif dans la ville.

| Champ         | Type       | Requis | Description |
|---------------|------------|--------|-------------|
| `id`          | `string`   | oui    | Identifiant unique **au sein de la ville** |
| `type`        | `NodeType` | oui    | Type de brique : `"app"`, `"db"`, `"cache"` ou `"queue"` |
| `label`       | `string`   | oui    | Nom affiche au survol |
| `description` | `string`   | non    | Description affichee au survol |
| `links`       | `string[]` | oui    | IDs des noeuds cibles **dans la meme ville** (liens orientes) |

#### `links` (optionnel)

Tableau de liens inter-villes. Chaque lien connecte un noeud d'une ville a un noeud d'une autre ville.

| Champ   | Type     | Requis | Description |
|---------|----------|--------|-------------|
| `from`  | `string` | oui    | Noeud source au format `"cityId/nodeId"` |
| `to`    | `string` | oui    | Noeud cible au format `"cityId/nodeId"` |
| `label` | `string` | non    | Label affiche au survol du lien |

### 3.3 Types de noeuds et rendu 3D

| Type    | Modele 3D        | Couleur  | Source asset |
|---------|------------------|----------|--------------|
| `app`   | Skyscraper       | Bleu     | Kenney City Kit Commercial |
| `db`    | Tank industriel  | Vert     | Kenney City Kit Industrial |
| `cache` | Ecran ordinateur | Orange   | Kenney Furniture Kit |
| `queue` | Cheminee         | Violet   | Kenney City Kit Industrial |

### 3.4 Contraintes de validation

- Les `id` de villes sont **uniques globalement**
- Les `id` de noeuds sont **uniques au sein de leur ville**
- Les `links` d'un noeud referent des IDs de noeuds **dans la meme ville**
- Les liens inter-villes utilisent le format **`"cityId/nodeId"`** pour les deux extremites
- Aucune coordonnee n'est definie dans le JSON — le layout est calcule automatiquement

### 3.5 Exemple complet

```json
{
  "cities": [
    {
      "id": "paris-1",
      "name": "Server Paris 1",
      "description": "Prod primary server",
      "nodes": [
        {
          "id": "frontend",
          "type": "app",
          "label": "Frontend",
          "description": "Web UI serving React SPA",
          "links": ["api"]
        },
        {
          "id": "api",
          "type": "app",
          "label": "API Gateway",
          "description": "Business logic and routing",
          "links": ["db", "cache"]
        },
        {
          "id": "db",
          "type": "db",
          "label": "PostgreSQL",
          "description": "Main relational database",
          "links": []
        },
        {
          "id": "cache",
          "type": "cache",
          "label": "Redis",
          "description": "Session and data cache",
          "links": []
        }
      ]
    },
    {
      "id": "london-1",
      "name": "Server London 1",
      "description": "Analytics replica",
      "nodes": [
        {
          "id": "analytics-api",
          "type": "app",
          "label": "Analytics API",
          "links": ["analytics-db"]
        },
        {
          "id": "analytics-db",
          "type": "db",
          "label": "ClickHouse",
          "links": []
        }
      ]
    }
  ],
  "links": [
    {
      "from": "paris-1/api",
      "to": "london-1/analytics-api",
      "label": "Event stream"
    },
    {
      "from": "paris-1/db",
      "to": "london-1/analytics-db",
      "label": "DB replication"
    }
  ]
}
```

---

## 4. Architecture du projet

```
/src
 ├── domain/types.ts        # Modeles metier purs (World, City, GraphNode, etc.)
 ├── loaders/loadWorld.ts   # JSON → noeuds resolus + liens
 ├── layout/layoutCity.ts   # Calcul deterministe des positions (grille)
 ├── data/sample.json       # Donnees d'exemple
 ├── components/            # Composants React + Three.js
 │   ├── WorldScene.tsx     # Canvas, lumieres, grille, orbit controls, liens inter-villes
 │   ├── CityScene.tsx      # Sol, label, noeuds et liens intra-ville
 │   ├── NodeMesh.tsx       # Chargement GLB, tooltip, focus camera
 │   └── LinkMesh.tsx       # Lignes (intra) et arcs (inter-villes)
 ├── App.tsx                # Chargement des donnees + panneau toggle villes
 ├── frontend.tsx           # Point d'entree React
 └── index.css              # Tailwind + styles de base
```

Principes :
- **domain != render** — aucun import Three.js hors de `components/`
- Les composants recoivent des **donnees positionnees pre-calculees**
- Les modeles 3D sont dans `public/models/` (servis en statique par Vite)

---

## 5. Modele de donnees TypeScript

```ts
// Types de base
type NodeType = "app" | "db" | "cache" | "queue";

interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  links: string[];          // IDs intra-ville
}

interface InterCityLink {
  from: string;             // "cityId/nodeId"
  to: string;               // "cityId/nodeId"
  label?: string;
}

interface City {
  id: string;
  name: string;
  description?: string;
  nodes: GraphNode[];
}

interface World {
  cities: City[];
  links?: InterCityLink[];  // liens inter-villes
}

// Modeles resolus (apres chargement)
interface ResolvedNode extends GraphNode {
  cityId: string;
}

interface ResolvedLink {
  fromNodeId: string;
  fromCityId: string;
  toNodeId: string;
  toCityId: string;
  interCity: boolean;
  label?: string;
}

// Modele positionne (apres layout)
interface PositionedNode extends ResolvedNode {
  position: [number, number, number];
}
```

---

## 6. Layout

- Chaque ville occupe une **zone sur la grille**, decalee par son index (`cityIndex * 30` en X)
- Les noeuds sont places sur une **grille reguliere** (4 colonnes, espacement de 3 unites)
- Les liens intra-ville sont des **lignes droites au sol**
- Les liens inter-villes sont des **arcs eleves** (rouge, visibles quand les deux villes sont affichees)

---

## 7. Interactions (POC)

- **Hover** : tooltip avec label, description et type du noeud
- **Click** : recentrage de la camera sur le noeud clique
- **Toggle** : panneau de checkboxes pour afficher/masquer chaque ville
- **Hover sur lien inter-ville** : affiche le label et les extremites

---

## 8. Evolutions prevues

Phase 2 :
- Metriques dynamiques (CPU, memoire, latence)
- Animation des liens (flux de donnees)
- Agregation automatique

Phase 3 :
- Source Prometheus / OpenTelemetry
- Multi-cluster
- Filtres temporels

---

**Ce document est la reference du projet.**
