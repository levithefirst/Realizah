// Task understanding: what is being asked, what output modality it needs,
// which explicit constraints it states, and whether Realizah can execute it.
// Deterministic. It never decides what a model can do; that comes from the
// registry's verified metadata.
import {
  estimateTokens,
  extractCitationsRequired,
  extractCodeLanguage,
  extractFramework,
  extractLanguage,
  extractListCount,
  extractMustInclude,
  extractOutputFormat,
  extractRequiredFields,
  extractRequiredSections,
  extractWordCount,
  extractWantsTests,
  type OutputFormat,
  type WordCount,
} from "./constraints";

export type TaskCategory =
  | "writing"
  | "coding"
  | "reasoning"
  | "research"
  | "extraction"
  | "summarization"
  | "structured_json"
  | "mathematics"
  | "analysis"
  | "agentic"
  | "image_generation"
  | "image_understanding"
  | "video_generation"
  | "audio_generation"
  | "speech_to_text"
  | "text_to_speech";

export type OutputModality = "text" | "image" | "video" | "audio";

export type ProductCapability = "text" | "code" | "image" | "video" | "audio";

export type TaskConstraints = {
  wordCount: WordCount | null;
  outputFormat: OutputFormat;
  language: string | null;
  codeLanguage: string | null;
  framework: string | null;
  citationsRequired: boolean;
  requiredSections: string[];
  listCount: number | null;
  mustInclude: string[];
  requiredFields: string[];
  requiresTools: boolean;
  requiresWebAccess: boolean;
  requiresInputFile: "image" | "audio" | null;
  wantsTests: boolean;
  estimatedInputTokens: number;
};

export type TaskUnderstanding = {
  primary: TaskCategory;
  categories: TaskCategory[];
  outputModality: OutputModality;
  constraints: TaskConstraints;
  executable: boolean;
  notExecutableReason: string | null;
  warnings: string[];
  signals: string[];
};

const MEDIA_MAKE =
  "(?:make|makes|making|made|create|creates|creating|generate|generates|generating|produce|produces|producing|render|rendering|edit|edits|editing|animate|animating|design|designing|draw|drawing|record|recording|compose|composing|shoot|shooting|film|filming|paint|painting|upscale|upscaling|turn\\w*\\s+\\w+(?:\\s+\\w+){0,3}\\s+into|convert\\w*\\s+\\w+(?:\\s+\\w+){0,3}\\s+(?:in)?to)";
const FILL = "(?:\\s+\\w+){0,3}?";
const NOT_A_BUSINESS =
  "(?!\\s+(?:service|services|company|agency|startup|tool|tools|platform|business|product|brand|app|studio|team)\\b)";
const produces = (nouns: string) => new RegExp(`\\b${MEDIA_MAKE}${FILL}\\s+(?:${nouns})\\b${NOT_A_BUSINESS}`, "i");
const named = (nouns: string) =>
  new RegExp(`\\b(?:(?:${nouns})\\s+(?:generation|generator|creation|editing|editor|production)|ai\\s+(?:${nouns}))\\b${NOT_A_BUSINESS}`, "i");

const VIDEO = "videos?|films?|movies?|clips?|reels?|animations?|footage|b roll|tiktoks?";
const IMAGE = "images?|photos?|photographs?|pictures?|illustrations?|logos?|thumbnails?|artwork|art|drawings?|portraits?|headshots?|graphics?|posters?|memes?|banners?|icons?|avatars?";
const AUDIO = "music|songs?|beats?|jingles?|sound effects?";

// [category, weight, pattern]. Task text counts fully, the use case at half.
const RULES: [TaskCategory, number, RegExp][] = [
  ["video_generation", 6, produces(VIDEO)],
  ["video_generation", 6, named(VIDEO)],
  ["image_generation", 6, produces(IMAGE)],
  ["image_generation", 6, named(IMAGE)],
  ["audio_generation", 6, produces(AUDIO)],
  ["audio_generation", 6, named(AUDIO)],
  ["text_to_speech", 6, /\b(text to speech|tts|voice ?overs?|voice clon\w*|read (?:it|this) aloud|narrate (?:it|this) as audio|dubbing|lip ?sync\w*)\b/i],
  ["speech_to_text", 6, /\b(transcri(?:be|bes|bed|bing|ption|ptions)|speech to text)\b/i],
  ["image_understanding", 6, /\b(?:describe|analy[sz]e|caption|read|ocr|what(?:'s| is) in)\b(?:\s+\w+){0,3}?\s+(?:this|the|attached|my)\s+(?:image|photo|picture|screenshot|scan)\b/i],
  ["agentic", 5, /\b(browse|navigate to|go to (?:the )?website|click (?:on|the)|book (?:a|me)|schedule (?:a|the) meeting|send (?:an|the) email to|use (?:the )?(?:tools?|apis?)|call (?:the|an|this) api|autonomous(?:ly)?|agent that)\b/i],
  ["coding", 5, /```/],
  ["coding", 4, /\b(code|coding|program(?:ming)?|debug\w*|refactor\w*|compile\w*|unit tests?|stack trace|bug|implement (?:a|the)|function that|regex|endpoint|algorithm)\b/i],
  ["coding", 3, /\b(typescript|javascript|python|golang|rust|java|c\+\+|c#|php|ruby|swift|kotlin|sql query|bash script|react component|next\.?js|django|express)\b/i],
  ["structured_json", 5, /\b(json|yaml|schema|structured output|key[- ]value)\b/i],
  ["extraction", 4, /\b(extract|pull out|parse|find all|list all|identify all|entities)\b/i],
  // Reshaping given data: "Convert this list to CSV", "turn these rows into a table".
  ["extraction", 4, /\b(?:convert|transform|reformat|restructure|turn|put)\b[^.\n]{0,80}?\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:csv|tsv|table|spreadsheet|json|yaml|xml)\b/i],
  ["summarization", 4, /\b(summari[sz]e|summary|tl;?dr|recap|condense|key points|key takeaways)\b/i],
  ["mathematics", 4, /\b(solve|equation|integral|derivative|prove that|probability|arithmetic|algebra|calculus|math)\b|\d+\s*[\^*/+-]\s*\d+\s*=/i],
  // A bare arithmetic expression ("17*19", "3.5 × 4", "2^10", "120 / 8 + 3")
  // or a request to compute one. Hyphens and slashes alone are too ambiguous
  // (dates, ranges, "5-10 words"), so + - / count only after "what is"-style
  // asks; * x × ÷ ^ between numbers count anywhere.
  ["mathematics", 4, /\d(?:[\d.,]*\d)?\s*[*×÷^]\s*\(?-?\d|\b(?:what(?:'s| is)|calculate|compute|evaluate|how much is)\s+\(?-?\d[\d.,]*\s*(?:[-+*/×÷^x]|times|plus|minus|divided by)\s*\(?-?\d|\b(?:calculate|compute)\b|\b(?:square root|cube root|factorial|percent(?:age)? of|multiply|divided by)\b/i],
  ["reasoning", 3, /\b(logic puzzle|riddle|reason (?:about|through)|step[- ]by[- ]step|deduce|which (?:option|answer) is (?:correct|true)|chain of thought)\b/i],
  // A quantitative question to work out: "How much does the ball cost?",
  // "how many days until...?" — a question, not a request to write.
  ["reasoning", 3, /\b(?:how (?:much|many|long|old|far|fast)|what (?:time|day|age)|who (?:is|was) (?:older|taller|faster|right))\b[^?.!]*\?|\b(?:brain ?teaser|trick question|word problem)\b/i],
  ["research", 4, /\b(research|find sources|cite|citations?|references|literature review|what does the (?:research|evidence) say|market research|competitor research)\b/i],
  ["analysis", 3, /\b(analy[sz]e|analysis|evaluate|assess|compare|pros and cons|swot|insights|trends|critique)\b/i],
  ["writing", 4, /\b(?:write|draft|compose|rewrite|edit|proofread|polish)\b(?:\s+\w+){0,4}?\s+(?:article|blog|post|essay|email|letter|story|copy|caption|tweet|thread|newsletter|speech|script|bio|description|headline|ad|press release|cover letter|poem|lyrics|report|proposal|summary|outline|message|reply|review)s?\b/i],
  ["writing", 3, /\b(long[- ]form|copywriting|ghostwrit\w*|blog posts?|articles?|essays?|cold emails?|newsletters?|marketing copy|social media posts?)\b/i],
];

// Priority when scores tie: the more specific output wins.
const PRIORITY: TaskCategory[] = [
  "video_generation", "image_generation", "audio_generation", "text_to_speech", "speech_to_text",
  "image_understanding", "agentic", "structured_json", "coding", "extraction", "summarization",
  "mathematics", "research", "reasoning", "analysis", "writing",
];

const MODALITY_OF: Partial<Record<TaskCategory, OutputModality>> = {
  image_generation: "image",
  video_generation: "video",
  audio_generation: "audio",
  text_to_speech: "audio",
};

const WEB_ACCESS = /\b(latest|current(?:ly)?|today'?s|this week|up[- ]to[- ]date|search the web|browse|real[- ]time|live data|breaking news)\b/i;

function scoreText(text: string, weight: number, scores: Map<TaskCategory, number>, signals: string[], label: string) {
  for (const [cat, w, re] of RULES) {
    if (re.test(text)) {
      scores.set(cat, (scores.get(cat) ?? 0) + w * weight);
      signals.push(`${label}: ${cat}`);
    }
  }
}

export function understandTask(input: {
  task: string;
  useCase: string;
  productCapability?: ProductCapability | null;
}): TaskUnderstanding {
  const scores = new Map<TaskCategory, number>();
  const signals: string[] = [];
  scoreText(input.task, 1, scores, signals, "task");
  scoreText(input.useCase, 0.5, scores, signals, "use case");

  // A code-focused product nudges ambiguous tasks toward coding.
  if (input.productCapability === "code") {
    scores.set("coding", (scores.get("coding") ?? 0) + 1);
    signals.push("product: code tool");
  }

  const ranked = [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]))
    .map(([c]) => c);

  let primary: TaskCategory = ranked[0] ?? "writing";
  if (!ranked.length) signals.push("no specific signal: treated as general text writing");

  // A media product with no explicit text deliverable: the work is that media.
  const textDeliverable = ranked.some((c) => !MODALITY_OF[c] && c !== "image_understanding" && c !== "speech_to_text" && (scores.get(c) ?? 0) >= 3);
  const pc = input.productCapability;
  if ((pc === "image" || pc === "video" || pc === "audio") && !textDeliverable) {
    primary = pc === "image" ? "image_generation" : pc === "video" ? "video_generation" : "audio_generation";
    signals.push(`product: ${pc} tool with no text deliverable`);
    if (!ranked.includes(primary)) ranked.unshift(primary);
  }

  const combined = `${input.useCase}\n${input.task}`;
  const outputModality: OutputModality = MODALITY_OF[primary] ?? "text";
  const constraints: TaskConstraints = {
    wordCount: extractWordCount(input.task),
    outputFormat: primary === "structured_json" ? "json" : extractOutputFormat(input.task) ?? (primary === "coding" ? "code" : null),
    language: extractLanguage(input.task),
    codeLanguage: extractCodeLanguage(combined),
    framework: extractFramework(combined),
    citationsRequired: extractCitationsRequired(input.task),
    requiredSections: extractRequiredSections(input.task),
    listCount: extractListCount(input.task),
    mustInclude: extractMustInclude(input.task),
    requiredFields: primary === "structured_json" || /\bjson\b/i.test(input.task) ? extractRequiredFields(input.task) : [],
    requiresTools: primary === "agentic",
    requiresWebAccess: WEB_ACCESS.test(input.task) && (primary === "research" || ranked.includes("research")),
    requiresInputFile: primary === "image_understanding" ? "image" : primary === "speech_to_text" ? "audio" : null,
    wantsTests: primary === "coding" && extractWantsTests(input.task),
    estimatedInputTokens: estimateTokens(input.task),
  };

  let notExecutableReason: string | null = null;
  if (outputModality !== "text") {
    notExecutableReason = `This is ${outputModality === "image" || outputModality === "audio" ? "an" : "a"} ${outputModality}-generation task. Realizah can't run ${outputModality} comparisons yet, and text models are not a substitute.`;
  } else if (constraints.requiresInputFile) {
    notExecutableReason = `This task needs an ${constraints.requiresInputFile} file as input. Realizah doesn't accept uploads yet.`;
  } else if (constraints.requiresTools) {
    notExecutableReason = "This is an agentic task that needs tools or browsing. Realizah doesn't provide a tool environment yet.";
  }

  const warnings: string[] = [];
  if (!notExecutableReason && constraints.requiresWebAccess) {
    warnings.push("This task asks for current information. Models run without web access, so answers reflect their training data.");
  }

  return {
    primary,
    categories: ranked.length ? ranked : ["writing"],
    outputModality,
    constraints,
    executable: notExecutableReason === null,
    notExecutableReason,
    warnings,
    signals,
  };
}

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  writing: "writing",
  coding: "coding",
  reasoning: "reasoning",
  research: "research",
  extraction: "extraction",
  summarization: "summarization",
  structured_json: "structured JSON",
  mathematics: "mathematics",
  analysis: "analysis",
  agentic: "agentic / tool use",
  image_generation: "image generation",
  image_understanding: "image understanding",
  video_generation: "video generation",
  audio_generation: "audio generation",
  speech_to_text: "speech to text",
  text_to_speech: "text to speech",
};

// The user's explicit word limit replaces whatever the task text implied.
// Applied before planning, so the output budget, selection, max_tokens and
// evaluation all use the same limit.
export function applyWordMaxOverride(u: TaskUnderstanding, wordMax: number | null | undefined): TaskUnderstanding {
  if (wordMax == null) return u;
  return {
    ...u,
    constraints: {
      ...u.constraints,
      wordCount: { min: null, max: wordMax, target: null, perItemMax: u.constraints.wordCount?.perItemMax ?? null, phrase: `your ${wordMax}-word limit` },
    },
    signals: [...u.signals, `word limit set by you: ${wordMax}`],
  };
}
