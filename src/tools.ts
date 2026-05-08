// Tool definitions for Kimi K2.5 function calling
// These map to Supabase queries against events, routes, and places

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "semantic_search",
      description:
        "Semantisk AI-søgning på tværs af events og steder. Brug DENNE FØRST når brugeren beskriver noget i naturligt sprog — fx 'hyggeligt sted til date', 'noget stille i weekenden', 'find live jazz i natur', 'romantisk aften'. Returnerer de mest semantisk relevante events og steder baseret på meningen, ikke kun keywords.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Brugerens beskrivelse i naturligt sprog. Skriv det som brugeren sagde det.",
          },
          kind: {
            type: "string",
            enum: ["events", "places", "both"],
            description: "Events, steder, eller begge dele. Default: both",
          },
          country: {
            type: "string",
            description: "Land-filter, fx 'DK', 'SE', 'NO' — kun hvis brugeren nævner et land",
          },
        },
        required: ["query"],
      },
    },
  },
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
  // ── Write tools (kræver JWT) ──────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "save_user_tags",
      description:
        "Gem brugerens interesse-tags. Brug når brugeren udtrykker interesse for noget ('jeg elsker MTB', 'jeg er til metal-koncerter'). Tilføjer til eksisterende tags, overskriver IKKE.",
      parameters: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag-slugs at tilføje, fx ['mtb','metal']",
          },
        },
        required: ["tags"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_user_prefs",
      description:
        "Gem brugerens preferences (by, group_mode, energy_level). Brug når brugeren oplyser fakta om sig selv ('jeg bor i Aalborg', 'jeg er typisk solo').",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "By, fx 'Aalborg'" },
          group_mode: {
            type: "string",
            enum: ["solo", "duo", "gruppe"],
            description: "Foretrukket gruppe-størrelse",
          },
          energy_level: {
            type: "string",
            enum: ["lav", "medium", "høj"],
            description: "Foretrukket energi-niveau",
          },
          experience_mode: {
            type: "string",
            description: "Erfarings-mode",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bookmark_place",
      description:
        "Gem et sted (place) eller event som bogmærke. Brug når brugeren siger 'gem den', 'tilføj til favoritter'.",
      parameters: {
        type: "object",
        properties: {
          place_id: { type: "string", description: "UUID på sted at gemme" },
          event_id: { type: "string", description: "UUID på event at gemme" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rsvp_event",
      description:
        "Tilmeld brugeren til et event. Brug når brugeren siger 'jeg vil med', 'tilmeld mig', 'reservér plads'.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "Event ID (text)" },
          status: {
            type: "string",
            enum: ["going", "interested", "not_going"],
            description: "RSVP-status, default 'going'",
          },
        },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_note",
      description:
        "Opret en note for brugeren. Brug når brugeren siger 'skriv en note', 'husk at...', 'noter at...'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note-titel" },
          content: { type: "string", description: "Note-indhold" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optionelle tags",
          },
        },
        required: ["content"],
      },
    },
  },
];

export type ToolCallArgs = {
  semantic_search: {
    query: string;
    kind?: "events" | "places" | "both";
    country?: string;
  };
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
  save_user_tags: {
    tags: string[];
  };
  save_user_prefs: {
    city?: string;
    group_mode?: "solo" | "duo" | "gruppe";
    energy_level?: "lav" | "medium" | "høj";
    experience_mode?: string;
  };
  bookmark_place: {
    place_id?: string;
    event_id?: string;
  };
  rsvp_event: {
    event_id: string;
    status?: "going" | "interested" | "not_going";
  };
  add_note: {
    title?: string;
    content: string;
    tags?: string[];
  };
};
