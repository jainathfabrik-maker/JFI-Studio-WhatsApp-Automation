import { dayOfYearInTz, dateKeyInTz, dateLabelInTz } from './util.js';
import { TransportError } from './http.js';

export const PILLARS = ['proof of work', 'price transparency', 'process', 'education', 'people', 'trust'];

export const BANNED_WORDS = ['luxury', 'dream', 'transform', 'seamless', 'elevate'];

const BENGALURU_PLACES = [
  'bengaluru', 'bangalore', 'indiranagar', 'koramangala', 'whitefield', 'jayanagar', 'hsr', 'hebbal',
  'malleshwaram', 'basavanagudi', 'rajajinagar', 'banashankari', 'sarjapur', 'bellandur', 'yelahanka',
  'electronic city', 'jp nagar', 'btm', 'marathahalli', 'hennur', 'kengeri', 'vidyaranyapura',
];

export class ContentError extends Error {
  constructor(message, { cause, attempts } = {}) {
    super(message);
    this.name = 'ContentError';
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

export function countWords(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Enforce the content brief mechanically rather than trusting the model.
 * Returns { ok, problems } — never throws, so the caller can retry with the
 * problems as feedback and then fail loudly instead of sending junk.
 */
export function validatePack(pack) {
  const problems = [];
  if (!pack || typeof pack !== 'object') return { ok: false, problems: ['pack is not an object'] };

  const str = (key) => (typeof pack[key] === 'string' ? pack[key].trim() : '');
  const arr = (key) => (Array.isArray(pack[key]) ? pack[key].filter((v) => typeof v === 'string' && v.trim()) : []);

  if (!PILLARS.includes(str('pillar'))) problems.push(`pillar must be one of: ${PILLARS.join(', ')}`);
  if (!str('format')) problems.push('format is required (format and duration, e.g. "Reel, 24–30s, vertical 9:16")');

  const hook = str('hook');
  if (!hook) problems.push('hook is required');
  else {
    const words = countWords(hook);
    if (words > 12) problems.push(`hook has ${words} words; the brief allows at most 12`);
    const hasNumber = /\d/.test(hook);
    const hasPlace = BENGALURU_PLACES.some((place) => hook.toLowerCase().includes(place));
    if (!hasNumber && !hasPlace) problems.push('hook must contain a number or a Bengaluru place name');
  }

  if (str('caption').length < 80) problems.push('caption is too short to be publishable (aim for at least 80 characters)');
  if (!str('cta')) problems.push('cta is required');

  const hashtags = arr('hashtags');
  if (hashtags.length < 5) problems.push('hashtags must contain at least 5 entries');
  if (hashtags.some((tag) => !tag.trim().startsWith('#'))) problems.push('every hashtag must start with "#"');

  if (arr('shotList').length < 3) problems.push('shotList must contain at least 3 concrete shots');

  const publish = str('publishTimeIST');
  if (!publish) problems.push('publishTimeIST is required');
  else if (!/IST/i.test(publish)) problems.push('publishTimeIST must state the time in IST, e.g. "7:30 PM IST"');

  const haystack = `${hook} ${str('caption')} ${str('cta')}`.toLowerCase();
  const banned = BANNED_WORDS.filter((word) => haystack.includes(word));
  if (banned.length) problems.push(`remove these off-brand words: ${banned.join(', ')}`);

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Static pack bank — deterministic, offline, zero cost. Used when no OpenAI
// key is configured, or explicitly with CONTENT_SOURCE=static.
// ---------------------------------------------------------------------------
const STATIC_PACKS = {
  'proof of work': {
    format: 'Reel, 24–30s, vertical 9:16, no voiceover — on-screen text only',
    hook: 'Indiranagar 3BHK: 11 weeks, one site visit a week',
    caption:
      'A 3BHK in Indiranagar, handed over in 11 weeks with a weekly site visit logged every Saturday. This reel is the actual sequence: demolition, plumbing rough-in, false ceiling framing, carpentry, painting, handover. No renders, no before-and-after trickery — the same rooms in the same order we worked on them.',
    cta: 'Save this if you are planning a 2027 fit-out. WhatsApp us "INDIRANAGAR" for the week-by-week schedule we used.',
    hashtags: ['#BengaluruInteriors', '#InteriorDesignBangalore', '#Indiranagar', '#TurnkeyInteriors', '#HomeRenovation', '#JFIStudio', '#FitOut'],
    shotList: [
      '0–3s: doorway push-in, empty flat, natural light only',
      '3–8s: three quick cuts of demolition debris being cleared',
      '8–14s: plumbing rough-in wall, then the same wall closed and painted',
      '14–20s: false ceiling framing to finished ceiling with cove lighting',
      '20–26s: carpentry install, close on handle detail',
      '26–30s: final wide of the living room, lights on, end card',
    ],
    publishTimeIST: '7:30 PM IST',
  },
  'price transparency': {
    format: 'Carousel, 6 slides, 1080×1350, plus a 15s Reel cut',
    hook: 'What ₹18 lakh actually buys in a 2BHK, line by line',
    caption:
      'An honest cost split for a 1,050 sq ft 2BHK refurbishment in Bengaluru: civil and plumbing, electrical, false ceiling, modular kitchen, wardrobes, painting, and the site supervision line most quotes hide. Figures are ranges from our own 2025–26 work, not a quotation, and they change with material grade and building rules.',
    cta: 'Comment "COST" and we will send the same split as a one-page PDF you can compare against any quote.',
    hashtags: ['#InteriorCostBangalore', '#RenovationBudget', '#PriceTransparency', '#BengaluruInteriors', '#ModularKitchen', '#JFIStudio'],
    shotList: [
      'Slide 1: total range in large type, no decoration',
      'Slide 2: civil + plumbing range with what moves it',
      'Slide 3: electrical + false ceiling range',
      'Slide 4: modular kitchen and wardrobe range per running foot',
      'Slide 5: painting, hardware, and the supervision line',
      'Slide 6: what is excluded, and the CTA',
    ],
    publishTimeIST: '1:00 PM IST',
  },
  process: {
    format: 'Reel, 30–40s, vertical 9:16, text overlays at each checkpoint',
    hook: 'Whitefield handover: 14 checkpoints before we hand over keys',
    caption:
      'We do not hand over keys on a phone call. This is the 14-point check we run on every Whitefield and Sarjapur project: door alignment, drawer travel, plumbing leak test, MCB labelling, tile lippage, paint sheen under daylight, and the rest. If a checkpoint fails, the handover moves — not the checklist.',
    cta: 'WhatsApp us "CHECKLIST" and we will send the 14-point list as a printable sheet.',
    hashtags: ['#Whitefield', '#InteriorProcess', '#HandoverChecklist', '#BengaluruInteriors', '#QualityControl', '#JFIStudio'],
    shotList: [
      '0–4s: hand holding the printed checklist, keys in frame',
      '4–12s: three fast checkpoint shots with a red cross then a tick',
      '12–22s: plumbing leak test under the sink, MCB panel close-up',
      '22–32s: paint sheen check by the window in daylight',
      '32–40s: signature on the sheet, keys handed over, end card',
    ],
    publishTimeIST: '11:30 AM IST',
  },
  education: {
    format: 'Carousel, 5 slides, 1080×1350 — flat diagrams, no stock photos',
    hook: '3 plywood grades and where each one belongs in Bengaluru',
    caption:
      'Most moisture damage in Bengaluru kitchens starts with the wrong plywood in the wrong place. This carousel explains the three grades we actually specify, what each costs per sheet, and the exact locations each one belongs in — including the one spot people skip: the sink cabinet base.',
    cta: 'Save this before your carpenter places the plywood order. Questions? WhatsApp us "PLYWOOD".',
    hashtags: ['#PlywoodGuide', '#BengaluruInteriors', '#MaterialsEducation', '#ModularKitchen', '#HomeRenovation', '#JFIStudio'],
    shotList: [
      'Slide 1: three sheets stacked, grade labels in large type',
      'Slide 2: grade one — where it goes, where it must not',
      'Slide 3: grade two — cost per sheet and the trade-off',
      'Slide 4: grade three — the sink cabinet base rule',
      'Slide 5: one-line summary table plus CTA',
    ],
    publishTimeIST: '9:00 AM IST',
  },
  people: {
    format: 'Reel, 20–25s, vertical 9:16, one continuous interview take',
    hook: 'Our site supervisor has finished 60 Jayanagar kitchens',
    caption:
      'Ramesh has finished 60 kitchens in Jayanagar and Basavanagudi, and he can tell from the sound of a drawer whether the channel is aligned. Twenty seconds of him explaining the one thing he checks before the countertop template goes in. The people who build your interiors are the product.',
    cta: 'Want to meet the team on a live site? WhatsApp us "SITE VISIT" and we will share the next open Saturday.',
    hashtags: ['#Jayanagar', '#SiteTeam', '#PeopleOfJFI', '#BengaluruInteriors', '#Carpentry', '#JFIStudio'],
    shotList: [
      '0–3s: supervisor in a finished kitchen, mid-sentence, no intro',
      '3–12s: cutaway to his hands checking a drawer channel',
      '12–18s: countertop template being marked',
      '18–25s: him looking at camera, end card',
    ],
    publishTimeIST: '6:30 PM IST',
  },
  trust: {
    format: 'Static post, 1080×1350, plain text on a neutral background',
    hook: 'Read the 9-clause contract before you pay any advance',
    caption:
      'Nine clauses we put in every JFI Studio contract, and why each one exists: payment linked to milestones, a written change-order process, material brand substitution rules, a delay clause that binds us too, and a defined handover checklist. If a contractor will not show you their contract before you pay, that is the answer.',
    cta: 'WhatsApp us "CONTRACT" for a redacted copy of our standard agreement to compare against what you have been offered.',
    hashtags: ['#ContractTransparency', '#BengaluruInteriors', '#HomeRenovation', '#CustomerTrust', '#InteriorDesignBangalore', '#JFIStudio'],
    shotList: [
      'Single frame: clause headings stacked in a clean list',
      'Highlight clause 3 (payment milestones) and clause 7 (delay clause)',
      'Footer: brand mark plus CTA line',
    ],
    publishTimeIST: '8:00 PM IST',
  },
};

function buildStaticPack({ timezone, now }) {
  const dayIndex = dayOfYearInTz(timezone, now);
  const pillar = PILLARS[dayIndex % PILLARS.length];
  const source = STATIC_PACKS[pillar];
  return {
    pillar,
    format: source.format,
    hook: source.hook,
    caption: source.caption,
    cta: source.cta,
    hashtags: [...source.hashtags],
    shotList: [...source.shotList],
    publishTimeIST: source.publishTimeIST,
  };
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pillar', 'format', 'hook', 'caption', 'cta', 'hashtags', 'shotList', 'publishTimeIST'],
  properties: {
    pillar: { type: 'string', enum: PILLARS },
    format: { type: 'string' },
    hook: { type: 'string' },
    caption: { type: 'string' },
    cta: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    shotList: { type: 'array', items: { type: 'string' } },
    publishTimeIST: { type: 'string' },
  },
};

function buildPrompt({ dateLabel, pillar, problems }) {
  const lines = [
    'You write the daily social content pack for JFI Studio, an architect-led turnkey interior studio in Bengaluru, India.',
    'Work is residential: full-home interiors, renovations, modular kitchens, wardrobes, false ceilings, painting and site execution.',
    `Today is ${dateLabel}. Content pillar for today: ${pillar}.`,
    '',
    'Return one pack with exactly these fields:',
    '- format: the format and duration, e.g. "Reel, 24-30s, vertical 9:16".',
    '- pillar: repeat the pillar exactly as given above.',
    '- hook: at most 12 words, and it must contain a number or a Bengaluru place name.',
    '- caption: ready to publish, 400-900 characters, specific and plain.',
    '- cta: one clear call to action that works on WhatsApp.',
    '- hashtags: 6-8 tags, each starting with #.',
    '- shotList: 4-6 concrete, filmable shots with timings or framing.',
    '- publishTimeIST: a suggested time in IST, e.g. "7:30 PM IST".',
    '',
    'Hard rules:',
    '- Never invent project results, testimonials, client names, addresses, awards or exact prices. Use ranges and say they are ranges.',
    '- Do not use the words: luxury, dream, transform, seamless, elevate.',
    '- Write for a Bengaluru homeowner who is comparing three quotes. No hype, no stock phrases.',
    '- Mixed English with natural Kannada is fine in the caption; keep the hook in English.',
  ];
  if (problems?.length) {
    lines.push('', 'Your previous answer was rejected for these reasons. Fix all of them:', ...problems.map((p) => `- ${p}`));
  }
  return lines.join('\n');
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const items = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of items) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

export function createContentGenerator({ config, logger, http, now = () => Date.now() }) {
  const generateStatic = (nowMs) => buildStaticPack({ timezone: config.timezone, now: nowMs });

  async function callOpenAI({ dateLabel, pillar, problems }) {
    const response = await http('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel,
        input: buildPrompt({ dateLabel, pillar, problems }),
        max_output_tokens: 1600,
        text: {
          format: {
            type: 'json_schema',
            name: 'jfi_content_pack',
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      }),
      timeoutMs: config.openaiTimeoutMs,
      maxRetries: 1,
      label: 'openai responses',
    });

    if (!response.ok) {
      const detail = response.data?.error?.message ?? `HTTP ${response.status}`;
      throw new ContentError(`OpenAI request failed: ${detail}`);
    }
    if (response.data?.status === 'incomplete') {
      throw new ContentError('OpenAI returned an incomplete response (likely max_output_tokens).');
    }
    const text = extractOutputText(response.data);
    if (!text) throw new ContentError('OpenAI returned no text output.');
    const parsed = extractJson(text);
    if (!parsed) throw new ContentError('OpenAI output was not valid JSON.');
    return parsed;
  }

  return {
    /** Generate (and validate) one content pack. Throws ContentError on failure. */
    async generate({ nowMs = now() } = {}) {
      const dateKey = dateKeyInTz(config.timezone, nowMs);
      const dateLabel = dateLabelInTz(config.timezone, nowMs);
      const pillar = PILLARS[dayOfYearInTz(config.timezone, nowMs) % PILLARS.length];

      let body;
      let source = 'static';
      let model;

      if (config.effectiveContentSource === 'openai') {
        source = 'openai';
        model = config.openaiModel;
        let problems = null;
        let lastProblems = ['unknown'];
        let attempt = 0;
        let generated = null;

        while (attempt < 2) {
          attempt += 1;
          try {
            generated = await callOpenAI({ dateLabel, pillar, problems });
          } catch (error) {
            if (error instanceof ContentError) throw error;
            if (error instanceof TransportError) throw new ContentError(`OpenAI unreachable: ${error.message}`, { cause: error });
            throw error;
          }
          const check = validatePack(generated);
          if (check.ok) {
            problems = null;
            break;
          }
          problems = check.problems;
          lastProblems = check.problems;
          logger.warn('Generated pack failed validation; retrying once', { attempt, problems: check.problems });
          generated = null;
        }

        if (!generated) {
          throw new ContentError(
            `OpenAI content failed validation after ${attempt} attempt(s): ${lastProblems.join('; ')}`,
            { attempts: attempt },
          );
        }
        body = generated;
      } else {
        body = generateStatic(nowMs);
      }

      const pack = {
        ...body,
        pillar: PILLARS.includes(body.pillar) ? body.pillar : pillar,
        date: dateKey,
        dateLabel,
        timezone: config.timezone,
        source,
        ...(model ? { model } : {}),
        generatedAt: new Date(nowMs).toISOString(),
      };

      const check = validatePack(pack);
      if (!check.ok) {
        throw new ContentError(`Pack failed validation: ${check.problems.join('; ')}`);
      }
      return pack;
    },

    /** Exposed for tests and the admin diagnostics endpoint. */
    validatePack,
  };
}

/** Plain-text rendering of a pack, used for text delivery and the pack page. */
export function packToText(pack) {
  return [
    `JFI STUDIO — CONTENT PACK · ${pack.dateLabel}`,
    `Pillar: ${pack.pillar}`,
    `Format: ${pack.format}`,
    '',
    `HOOK (max 12 words)`,
    pack.hook,
    '',
    `CAPTION`,
    pack.caption,
    '',
    `CALL TO ACTION`,
    pack.cta,
    '',
    `HASHTAGS`,
    pack.hashtags.join(' '),
    '',
    `SHOT LIST`,
    ...pack.shotList.map((shot, index) => `${index + 1}. ${shot}`),
    '',
    `PUBLISH: ${pack.publishTimeIST}`,
  ].join('\n');
}
