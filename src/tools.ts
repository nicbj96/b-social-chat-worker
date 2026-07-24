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
          city: {
            type: "string",
            description:
              "By brugeren er i eller spørger om, fx 'Aalborg', 'København', 'Aarhus'. Sæt ALTID denne når brugeren nævner hvor de er eller hvor de vil hen — ellers får de resultater fra hele landet.",
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
          city: {
            type: "string",
            description: "Bynavn at filtrere eventets location på, f.eks. 'Aarhus'",
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
              "Overordnet kategori (rigtige slugs): natur-outdoor, mad-drikke, kultur-kunst, motion-fitness, musik-lyd, børn-familie, rejser-eventyr, sundhed-wellness, social-hobby",
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
        "Du SKAL kalde dette tool ENHVER gang brugeren udtrykker en interesse, et ønske eller en hobby ('jeg elsker MTB', 'jeg er til metal-koncerter', 'yoga er min ting', 'jeg går meget op i løb'). Konvertér interessen til tag-slugs (lower-case, ingen mellemrum, fx 'mtb', 'metal', 'yoga', 'lob'). Tilføjer til eksisterende tags, overskriver IKKE. SIG ALDRIG 'jeg har gemt' uden at have kaldt dette tool først.",
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
        "Du SKAL kalde dette tool når brugeren oplyser fakta om sig selv — by, gruppe-mode, energi-niveau eller erfarings-mode. " +
        "Genkend ALLE disse danske formuleringer for by og pak værdien ind i city: " +
        "'jeg bor i [by]', 'jeg bor [by]', 'min by er [by]', 'min by [by]', 'jeg er fra [by]', 'jeg kommer fra [by]', " +
        "'jeg holder til i [by]', 'jeg er bosat i [by]', 'jeg er i [by]', '[by] er min by', 'jeg bor tæt på [by]'. " +
        "Eksempler: 'jeg bor i Aalborg' → {city:'Aalborg'}. 'min by er København' → {city:'København'}. 'jeg er fra Aarhus' → {city:'Aarhus'}. " +
        "'jeg er typisk solo' → {group_mode:'solo'}. 'jeg foretrækker rolig energi' → {energy_level:'lav'}. " +
        "Capitaliser altid bynavnet (Aalborg, ikke aalborg). SIG ALDRIG 'jeg har noteret' uden at have kaldt dette tool først.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "Bynavn (capitaliseret), fx 'Aalborg', 'København', 'Aarhus'. UDDRAG fra alle danske 'jeg bor i', 'min by er', 'jeg er fra' formuleringer." },
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
        "Du SKAL kalde dette tool når brugeren siger 'gem den', 'bookmark det', 'tilføj til favoritter', 'husk dette sted'. Brug place_id for steder eller event_id for events fra konteksten. SIG ALDRIG 'jeg har gemt' uden at have kaldt dette tool først.",
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
        "Du SKAL kalde dette tool når brugeren siger 'jeg vil med', 'tilmeld mig', 'reservér plads', 'sæt mig på listen', 'jeg er på'. Default status='going'. SIG ALDRIG 'du er tilmeldt' uden at have kaldt dette tool først.",
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
        "Du SKAL kalde dette tool når brugeren siger 'skriv en note', 'husk at...', 'noter at...', 'lav et memo'. SIG ALDRIG 'jeg har noteret' uden at have kaldt dette tool først.",
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
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description:
        "Hent vejrudsigten for et UDENDØRS event eller sted på en bestemt dato. Brug KUN når vejret er relevant — udendørs events (festival, marked, løb, udendørs koncert, byvandring), eller når brugeren spørger om vejr/regn/tøj. Brug latitude+longitude fra et event eller sted du allerede har fundet. Virker kun ~16 dage frem; hvis der ikke er nogen udsigt, så sig at det er for langt ude. Opfind ALDRIG vejr.",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Breddegrad for stedet/eventet" },
          longitude: { type: "number", description: "Længdegrad for stedet/eventet" },
          date: { type: "string", description: "Eventets dato i formatet YYYY-MM-DD" },
        },
        required: ["latitude", "longitude", "date"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "estimate_travel_time",
      description:
        "Estimér OMTRENTLIG afstand og rejsetid mellem to punkter — fx fra brugerens position til et event, eller mellem to events i en aftenplan (flere stop). Det er et GROVT skøn ud fra fugleflugtsafstand; sig altid 'cirka'. Brug til at vurdere om noget er i nærheden, eller til at sammensætte en realistisk rækkefølge af stop på en aften.",
      parameters: {
        type: "object",
        properties: {
          from_latitude: { type: "number", description: "Startpunkt breddegrad" },
          from_longitude: { type: "number", description: "Startpunkt længdegrad" },
          to_latitude: { type: "number", description: "Slutpunkt breddegrad" },
          to_longitude: { type: "number", description: "Slutpunkt længdegrad" },
          mode: {
            type: "string",
            enum: ["walk", "bike", "transit", "car"],
            description: "Transportform. Default 'transit' (offentlig transport)",
          },
        },
        required: ["from_latitude", "from_longitude", "to_latitude", "to_longitude"],
      },
    },
  },
];

export type ToolCallArgs = {
  semantic_search: {
    query: string;
    kind?: "events" | "places" | "both";
    country?: string;
    city?: string;
  };
  search_events: {
    category?: string;
    tags?: string;
    mode?: string;
    indoor_outdoor?: string;
    city?: string;
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
