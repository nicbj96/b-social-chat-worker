// Tool definitions for Kimi K2.5 function calling
// These map to Supabase queries against events, routes, and places

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_events",
      description:
        "Søg efter events og aktiviteter i B Social. Brug denne funktion når brugeren vil finde events, koncerter, løb, festivaler eller andre arrangementer.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Event-kategori: sport, musik, festival, kunst, comedy, foredrag, friluftsliv, gaming, mad_drikke, natur, social",
          },
          tags: {
            type: "string",
            description:
              "Komma-separerede tags at søge efter, f.eks. 'løb,maraton' eller 'metal,rock'",
          },
          mode: {
            type: "string",
            enum: ["solo", "duo", "gruppe"],
            description: "Om brugeren vil deltage solo, i par, eller i gruppe",
          },
          indoor_outdoor: {
            type: "string",
            enum: ["indoor", "outdoor"],
            description: "Om brugeren foretrækker indendørs eller udendørs",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_routes",
      description:
        "Søg efter ruter (vandring, løb, MTB, cykling). Brug denne funktion når brugeren vil finde en rute at gå, løbe eller cykle.",
      parameters: {
        type: "object",
        properties: {
          activity_type: {
            type: "string",
            enum: ["hike", "run", "mtb", "bike"],
            description: "Type aktivitet: hike (vandring), run (løb), mtb (mountainbike), bike (cykling)",
          },
          difficulty: {
            type: "string",
            enum: ["let", "moderat", "kraevende"],
            description: "Sværhedsgrad",
          },
          max_distance_km: {
            type: "number",
            description: "Maksimal distance i kilometer",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_places",
      description:
        "Søg efter steder (parker, træningsområder, naturområder osv.). Brug denne funktion når brugeren vil finde et sted at træne, hænge ud, eller udforske.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Overordnet kategori: natur, aktiv_sport, mad_hangout",
          },
          tags: {
            type: "string",
            description:
              "Komma-separerede tags, f.eks. 'mtb,singletrack' eller 'havnebad,park'",
          },
          city: {
            type: "string",
            description: "Bynavn at filtrere på, f.eks. 'Aalborg'",
          },
        },
      },
    },
  },
];

export type ToolCallArgs = {
  search_events: {
    category?: string;
    tags?: string;
    mode?: string;
    indoor_outdoor?: string;
  };
  search_routes: {
    activity_type?: string;
    difficulty?: string;
    max_distance_km?: number;
  };
  search_places: {
    category?: string;
    tags?: string;
    city?: string;
  };
};
