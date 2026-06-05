// Demo corpus generator — TechCorp exit survey (synthetic, seeded, committed).
//
// Run:  node demo/generate.js
// Emits demo/techcorp-exit-survey.csv (~2,500 rows) and demo/oracle.json (the
// EXACT per-row theme flags MockModel's oracle reads, keyed by respondent_id).
//
// Everything is drawn from one mulberry32 stream (seed 7341): re-running this
// script regenerates BYTE-IDENTICAL files. No Date.now() anywhere — exit_date
// derives from the rng inside a fixed 18-month window, and the only stamp in
// the outputs is the seed itself (a timestamp would break determinism).
// The CSV carries no comment header: parsers treat every line as data, so the
// provenance stamp lives in oracle.json's "generated" field instead.
//
// Planted themes (targets; realized rates land within ~±0.02 and are recorded
// in oracle.json so tests assert against REALIZED truth, not the target):
//   pay              0.28   ↑Sales, ↑low satisfaction (↓satisfaction overall)
//   management       0.22   ↑Operations
//   workload         0.25   ↑tenure < 2 years (burnout language)
//   growth           0.18   ↑IC role
//   remote           0.12   region-skewed ↑NA/EMEA (return-to-office gripes)
//   quitRegret       0.06   flat, rare ("part of me wishes I had stayed")
//   quitIntent       —      not base-rated: quit-intent language fires mostly
//                           when satisfaction ≤ 2 (P≈0.42 vs 0.04 otherwise)
// Dirt, like real survey exports: ~2% junk ("n/a", "asdf", "."), ~1% exact
// duplicate texts (copy-paste respondents — flags copied with the text so the
// text→truth oracle stays well-defined), one 7-row bot burst (identical
// ≥6-token text), ~3% Spanish responses (theme flags still recorded; Spanish
// clause banks carry the same planted vocabulary in Spanish).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../server/core/rng.js";

export const SEED = 7341;
export const N_ROWS = 2500;

// ------------------------------------------------------------- demographics

const DEPTS = [
  ["Engineering", 0.30], ["Sales", 0.20], ["Operations", 0.16],
  ["Support", 0.14], ["Marketing", 0.10], ["People", 0.10],
];
const ROLES = [["IC", 0.62], ["Lead", 0.16], ["Manager", 0.15], ["Director", 0.07]];
const REGIONS = [["NA", 0.45], ["EMEA", 0.25], ["APAC", 0.20], ["LATAM", 0.10]];
const SATISFACTION = [[1, 0.12], [2, 0.22], [3, 0.28], [4, 0.24], [5, 0.14]];

function pickWeighted(rand, pairs) {
  let r = rand();
  for (const [value, w] of pairs) {
    r -= w;
    if (r < 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

// 18-month exit window, fixed: 2024-07-01 .. 2025-12-31 (549 days), rng-derived.
const WINDOW_START_UTC = Date.UTC(2024, 6, 1);
const WINDOW_DAYS = 549;
function exitDate(rand) {
  const d = new Date(WINDOW_START_UTC + Math.floor(rand() * WINDOW_DAYS) * 86400000);
  return d.toISOString().slice(0, 10);
}

// tenure 0.25–18 years, skewed low (power 2.2 ≈ median ~4y, ~35% under 2y),
// quantized to quarters.
function tenure(rand) {
  return Math.round((0.25 + 17.75 * Math.pow(rand(), 2.2)) * 4) / 4;
}

// ------------------------------------------------- planted theme probabilities

// Each function returns P(theme | row metadata). Constants are calibrated so
// the marginal expectation lands on the planted target given the demographic
// mix above (the derivations are inline).
const THEME_PROBS = {
  // E = 0.235 + 0.15·P(Sales=0.20) + 0.08·P(sat≤2=0.34) ≈ 0.292 pre-dirt
  pay: (m) => 0.235 + (m.dept === "Sales" ? 0.15 : 0) + (m.satisfaction <= 2 ? 0.08 : 0),
  // E = 0.20 + 0.15·P(Ops=0.16) + 0.02·P(sat≤2=0.34) ≈ 0.231 (≈0.225 after dirt)
  management: (m) => 0.20 + (m.dept === "Operations" ? 0.15 : 0) + (m.satisfaction <= 2 ? 0.02 : 0),
  // E = 0.195 + 0.115·P(tenure<2≈0.35) ≈ 0.235 pre-dirt
  workload: (m) => 0.195 + (m.tenure_years < 2 ? 0.115 : 0),
  // E = 0.13 + 0.08·P(IC=0.62) ≈ 0.180
  growth: (m) => 0.13 + (m.role_level === "IC" ? 0.08 : 0),
  // E = 0.07 + 0.07·P(NA|EMEA=0.70) ≈ 0.119
  remote: (m) => 0.07 + (m.region === "NA" || m.region === "EMEA" ? 0.07 : 0),
  // flat and rare
  quitRegret: () => 0.06,
};
// Quit-intent language is satisfaction-driven, not base-rated.
const quitIntentProb = (m) => (m.satisfaction <= 2 ? 0.42 : 0.04);

export const THEME_TARGETS = {
  pay: 0.28, management: 0.22, workload: 0.25, growth: 0.18, remote: 0.12, quitRegret: 0.06,
};
const THEME_NAMES = ["pay", "management", "workload", "growth", "remote", "quitRegret"];
const ALL_FLAGS = [...THEME_NAMES, "quitIntent"];

// ------------------------------------------------------------- clause banks
//
// ~40 English clauses per theme, registers from terse to reflective, 5–20
// words each, vocabulary kept disjoint across themes (a pay clause never says
// "manager") so the planted flags are the only signal a clause carries.

const CLAUSES = {
  pay: [
    "the pay was simply too low for the work",
    "my salary stayed flat for three straight years",
    "compensation never kept up with the market",
    "I was underpaid compared to every offer I saw elsewhere",
    "the pay band was insulting once I learned what new hires got",
    "no raise came even after the best review of my life",
    "base salary here lags the industry by a wide margin",
    "the bonus was a rounding error this year",
    "pay is the reason, plain and simple",
    "I asked about a raise twice and got vague answers both times",
    "my paycheck did not reflect the scope I carried",
    "equity refreshers dried up and the salary never made up for it",
    "the comp review felt like theater with the outcome decided in advance",
    "they froze salaries while posting record numbers",
    "a competing offer beat my pay by forty percent",
    "the cost of living rose and my pay pretended not to notice",
    "low pay, full stop",
    "salary discussions went nowhere for two cycles",
    "the pay gap between old hires and new hires became impossible to ignore",
    "I could not justify staying at that salary",
    "compensation was the one thing they refused to discuss honestly",
    "the merit increase was two percent in a year of double-digit inflation",
    "pay transparency revealed exactly how far behind I was",
    "they paid below market and called it mission alignment",
    "what they pay senior people here would be junior pay anywhere else",
    "the salary offer to stay came only after I resigned, which said everything",
    "my pay never recovered from joining during the hiring freeze",
    "the on-target earnings were a fiction nobody hit",
    "commission structure changed mid-year and my pay dropped hard",
    "I did the math and the pay cut of staying was larger than the risk of leaving",
    "underpaid and tired of negotiating for scraps",
    "the annual raise did not even cover the parking increase",
    "pay was fine at hire and then quietly fell behind year after year",
    "two promotions in title with no movement in salary",
    "the compensation philosophy slide deck changed nothing about my paycheck",
    "honestly the salary was the deal breaker",
    "I loved the product but the pay made the decision for me",
    "the retention bonus went to someone else doing half the work",
    "pay compression meant my new report earned more than I did",
    "the salary was uncompetitive and everyone in my cohort knew it",
  ],
  management: [
    "my manager never listened to a word the team said",
    "leadership changed direction every quarter without explanation",
    "the management layer above me was pure noise",
    "my boss took credit for the work and disappeared during the hard parts",
    "micromanagement made every small task a negotiation",
    "my supervisor canceled our one-on-ones for two months running",
    "management hid bad news until it was unavoidable",
    "the chain of command had five links and zero accountability",
    "my manager played favorites and everyone could see it",
    "leadership promised changes after the survey and delivered none",
    "decisions came down from above with no context and no discussion",
    "my boss managed up beautifully and managed down not at all",
    "the management churn meant four bosses in eighteen months",
    "my supervisor did not understand the work we actually did",
    "feedback only ever flowed one direction here",
    "management treated every concern as an attitude problem",
    "the skip-level meetings were scripted and pointless",
    "my manager promised the promotion and then pretended the conversation never happened",
    "leadership rewarded loyalty over results every single time",
    "the org chart reshuffles were management's answer to everything",
    "my boss was invisible until something went wrong",
    "middle management here exists to forward emails",
    "my manager could not make a decision without three approvals",
    "the directors fought each other and we absorbed the shrapnel",
    "management by panic, quarter after quarter",
    "my supervisor undermined me in front of the team twice",
    "the leadership offsite produced another slogan and nothing else",
    "no one above me ever said the words I was wrong",
    "my manager read my status reports back to me as insight",
    "leadership measured presence instead of outcomes",
    "the management training was a video from 2011",
    "my boss escalated everything and resolved nothing",
    "management ignored the postmortem actions three releases in a row",
    "my manager hoarded information like it was currency",
    "the executive team announced strategy by press release before telling us",
    "my supervisor rewrote my work at midnight without telling me why",
    "management here mistakes activity for progress",
    "my boss gave me a glowing review and a terrible rating",
    "leadership lost the plot and blamed the people pointing it out",
    "my manager was kind but powerless, which somehow felt worse",
  ],
  workload: [
    "the workload was relentless and the headcount never came",
    "burnout crept in during my first year and never left",
    "the hours stretched into every evening and most weekends",
    "on-call duty came around twice a month and wrecked my sleep",
    "I was doing the job of three people by the end",
    "the overtime was unpaid, expected, and endless",
    "every sprint was a death march with a new name",
    "I burned out, recovered a little, and burned out again",
    "the pace was unsustainable and everyone pretended otherwise",
    "deadlines were set before the work was scoped, every time",
    "I cannot remember my last week without a fire drill",
    "exhaustion became my baseline state",
    "the backlog grew faster than any human could drain it",
    "covering two open roles for a year hollowed me out",
    "work bled into nights until the nights were gone",
    "the crunch was supposed to be temporary and lasted fourteen months",
    "I hit a wall of fatigue I could not push through anymore",
    "the queue never closed and neither did my laptop",
    "vacation meant doing the same work from a different chair",
    "the pager went off at 3am for things that could have waited",
    "no recovery time ever followed the big pushes",
    "my calendar was nine hours of meetings wrapped around real work at night",
    "we shipped on adrenaline for two years and I ran out",
    "the team shrank and the commitments did not",
    "weekend releases became routine and so did my exhaustion",
    "every quarter ended in a sprint that erased the weekends",
    "the load balancing was a spreadsheet that balanced nothing",
    "I asked for help with the volume and got a prioritization framework",
    "too much work, too few hands, too little honesty about it",
    "the burnout was visible in the whole team by spring",
    "I left to remember what rested feels like",
    "the always-on culture ate my evenings one slack ping at a time",
    "I clocked seventy-hour weeks through the last push",
    "capacity planning here is a hope and a calendar invite",
    "the firefighting never stopped long enough to fix the fire",
    "double duty across two teams drained everything I had",
    "my workload doubled after the layoffs and the thanks was a gift card",
    "chronic understaffing turned every small task into overtime",
    "the off-hours support rotation broke me",
    "I was exhausted on Monday mornings, which told me everything",
  ],
  growth: [
    "there was no growth path for someone in my role",
    "my career flatlined after the second year",
    "promotion criteria were a moving target I could never hit",
    "I stopped learning anything new a long time ago",
    "the advancement conversations were always next quarter, forever",
    "no development budget survived the planning cycle",
    "the career ladder ended two rungs above where I stood",
    "I wanted to grow into new skills and the role refused to grow with me",
    "the promotion went to an external hire, twice",
    "stagnation set in and nothing on the horizon promised otherwise",
    "my development plan was a document nobody opened twice",
    "the learning stipend vanished and so did the conferences",
    "I mastered the role and then it just repeated",
    "every growth opportunity was already spoken for",
    "the title changed once in five years and the work never did",
    "mentorship existed on a slide and nowhere else",
    "I asked for stretch projects and got maintenance work",
    "the skills I wanted to build had no home here",
    "progression here rewards tenure, not capability",
    "my trajectory was a flat line and I am too early in my career for that",
    "the internal mobility process was a black hole",
    "I outgrew the role and the company had nowhere for me to go",
    "no new challenges arrived after the platform stabilized",
    "the promotion freeze entered its third year",
    "I left to keep learning, simple as that",
    "career development meant a webinar link in a newsletter",
    "the lattice they promised was actually a ledge",
    "advancement required a sponsor and mine kept leaving",
    "I watched peers elsewhere lap me in scope and skills",
    "the role was a dead end dressed up as stability",
    "growth talks turned into retention talks only after I resigned",
    "my skills were getting stale on old tooling",
    "the path from senior to staff was a rumor",
    "I needed a new challenge and the backlog offered reruns",
    "upskilling happened on my own time or not at all",
    "the next step in my career did not exist inside this company",
    "two reorgs erased the role I was being groomed for",
    "I plateaued and nobody seemed to mind but me",
    "the apprenticeship culture died with the hiring freeze",
    "ambition here is a liability, so I took mine elsewhere",
  ],
  remote: [
    "the return to office mandate ignored everything we proved during remote years",
    "three days a week in the office added a commute and subtracted nothing else",
    "remote work made me productive and the new policy took it away",
    "the hybrid schedule was hybrid in name only",
    "I moved during the remote era and the office mandate stranded me",
    "the commute swallowed two hours a day for meetings I could take from home",
    "work from home was the one benefit I could not give up",
    "the office policy changed three times in a year",
    "badge tracking told me exactly how much they trusted us",
    "the anchor days filled the office without filling it with purpose",
    "my whole team is in other cities, so the office was a video call with worse chairs",
    "the RTO push felt like a quiet layoff and several of us took the hint",
    "flexibility was the deal when I joined and the deal changed",
    "remote-first hiring, office-first management",
    "the new in-office quota decided this for me",
    "I do my best work from home and the policy made that a violation",
    "the office is an open floor plan where deep work goes to die",
    "the commute cost more than the raise I never got",
    "they measured presence in the building instead of work in the product",
    "the work from home stipend disappeared along with the trust",
    "relocating closer to the office was never going to happen on this salary band",
    "the hybrid compromise satisfied nobody and exhausted everybody",
    "remote made my caregiving life possible and the mandate broke it",
    "the all-hands explained the office push with a culture word cloud",
    "my productivity data said remote works and the policy said come in anyway",
    "five years of remote results erased by one executive memo",
    "the office move tripled my commute overnight",
    "in-office Tuesdays became in-office Tuesday through Thursday became my exit",
    "the desk booking app was the final straw, somehow",
    "I joined as a remote employee and was reclassified without a conversation",
    "the timezone spread made office attendance pure ceremony",
    "the company sold flexibility in the offer letter and recalled it in year two",
    "commuting to take the same zoom calls broke something in me",
    "the office mandate landed hardest on the people farthest away",
    "home office setups went from reimbursed to forbidden",
    "the new policy counted days while the work counted for nothing",
    "remote work was a lifeline for my family and it got cut",
    "the open seating plan plus mandatory attendance equals headphones all day",
    "the flexibility I was promised at hire did not survive the new leadership",
    "I left over the commute, which is really to say over the mandate",
  ],
  quitRegret: [
    "part of me wishes I had stayed another year",
    "I second-guess the decision more than I expected to",
    "some mornings I miss the old rhythm and wonder if I jumped too soon",
    "there is real regret mixed in with the relief",
    "I left a few things unfinished that still nag at me",
    "in hindsight I might have pushed for a transfer instead of leaving",
    "I caught myself wishing I could undo the resignation that first month",
    "the grass was not as green as the offer letter promised",
    "a part of me will always wonder what the next year there held",
    "I miss the people more than I thought possible and it stings",
    "leaving felt right in the moment and complicated ever since",
    "if the timing had been different I think I would have stayed",
    "I regret how quickly I made the final call",
    "the goodbye was harder than the decision and the doubt lingers",
    "some weeks I genuinely wonder whether leaving was the mistake",
    "walking away from that project still feels unfinished",
    "the new place is fine, but fine has made me question the move",
    "I wish someone had talked me out of it, honestly",
    "my exit was rushed and a slower version of me might have stayed",
    "there are days the old badge photo gives me a pang of regret",
  ],
  quitIntent: [
    "I had to get out before it got worse",
    "quitting was the only option left on the table",
    "I would have resigned months earlier if I could have afforded it",
    "leaving was self-preservation at that point",
    "I quit without another job lined up, which says everything",
    "I started planning my exit after the second broken promise",
    "I could not stay another quarter",
    "resigning felt like surfacing for air",
    "I told myself one more bad month and I meant it",
    "walking out the door was the easiest hard decision I ever made",
    "I was counting the days until my vesting cliff and then I was gone",
    "everyone on my team is interviewing and I just went first",
    "I knew it was time to leave when Sunday nights filled with dread",
    "the decision to quit made itself by the end",
    "I handed in my notice the morning after the announcement",
    "I needed to leave for my own health and I finally did",
    "the exit was a long time coming and overdue",
    "I would quit again twice as fast knowing what I know",
    "I was done, fully and completely done",
    "the resignation letter sat in my drafts for six months before I sent it",
    "staying even one more cycle was never an option for me",
    "I left before it cost me more than a job",
    "my exit plan started the day the new policy dropped",
    "quitting cost me money and was worth every cent",
    "I chose to walk away and I have not looked back",
  ],
};

// No-theme filler: neutral exit-survey texture without planted vocabulary.
const FILLER = [
  "the team itself was genuinely kind",
  "the product problems were interesting most of the time",
  "the offboarding process was smooth and respectful",
  "I appreciated the honest conversations on the way out",
  "the company is full of talented people",
  "my time here taught me a lot about the industry",
  "the customers were the best part of the job",
  "the benefits package was reasonable overall",
  "I enjoyed the early years quite a bit",
  "the mission still resonates with me",
  "the tools and equipment were always solid",
  "my coworkers made the hard stretches bearable",
  "the office snacks deserve a small tribute",
  "the onboarding I received years ago was excellent",
  "I made friendships here that will outlast the job",
  "the codebase was cleaner than most I have seen",
  "the company swag was genuinely good, for what that is worth",
  "the holiday party was always a highlight",
  "I learned the trade here and I am grateful for that",
  "the internal documentation was surprisingly thorough",
  "the new role is closer to home, which mattered to my family",
  "an opportunity came along that was too specific to pass up",
  "this move is about geography more than anything",
  "a former colleague recruited me into the new role",
  "I am switching industries to be closer to healthcare work",
  "the relocation was for my partner's job",
  "I am taking time off before deciding what is next",
  "I am going back to school in the fall",
  "the startup itch finally won",
  "family circumstances made this change necessary",
  "no single reason, just the sense that the chapter ended",
  "it was simply time for something new",
  "I want to thank the people who trained me",
  "the exit interview questions were thoughtful, including this one",
  "the snacks were good and the coffee was terrible, for the record",
  "nothing dramatic to report from my corner",
  "I wish the next cohort a smooth ride",
  "the project I leave behind is in capable hands",
  "the interview process that brought me in was the best I have experienced",
  "overall a decent run with a quiet ending",
];

// Spanish clause banks (the ~3% Spanish rows compose from these; theme flags
// are recorded identically). Stopword-dense so language detection sees them.
const CLAUSES_ES = {
  pay: [
    "el salario era demasiado bajo para el trabajo que hacía",
    "el sueldo no subió en tres años y el mercado sí",
    "la compensación nunca fue competitiva y todos lo sabíamos",
    "me pagaban menos que cualquier oferta que recibí fuera",
    "pedí un aumento dos veces y nunca llegó",
    "el bono de este año fue una broma de mal gusto",
    "la paga no reflejaba la responsabilidad que llevaba",
    "los sueldos quedaron congelados mientras la empresa crecía",
  ],
  management: [
    "mi jefe nunca escuchaba lo que decía el equipo",
    "la dirección cambiaba de rumbo cada trimestre sin explicación",
    "mi supervisor cancelaba nuestras reuniones uno a uno sin aviso",
    "la gerencia escondía las malas noticias hasta el final",
    "los jefes premiaban la lealtad y no los resultados",
    "tuve cuatro jefes en dieciocho meses y ninguno decidía nada",
    "el liderazgo prometió cambios después de la encuesta y no hizo ninguno",
    "mi jefe se llevaba el crédito y desaparecía en los momentos difíciles",
  ],
  workload: [
    "la carga de trabajo era imposible y nunca llegó más gente",
    "el agotamiento empezó el primer año y nunca se fue",
    "las horas se comían todas las noches y los fines de semana",
    "hacía el trabajo de tres personas al final",
    "las guardias de madrugada me quitaron el sueño durante meses",
    "el ritmo era insostenible y todos fingían lo contrario",
    "no recuerdo una semana sin una urgencia de última hora",
    "me fui para recordar lo que se siente descansar",
  ],
  growth: [
    "no había camino de crecimiento para alguien en mi puesto",
    "mi carrera quedó estancada después del segundo año",
    "la promoción se la dieron a alguien de fuera, dos veces",
    "dejé de aprender cosas nuevas hace mucho tiempo",
    "el plan de desarrollo era un documento que nadie abría",
    "quería crecer y el puesto no crecía conmigo",
    "el presupuesto de formación desapareció con el plan anual",
    "me fui para seguir aprendiendo, así de simple",
  ],
  remote: [
    "la vuelta a la oficina ignoró todo lo que demostramos en remoto",
    "tres días en la oficina sumaron viaje y no sumaron nada más",
    "el trabajo desde casa era el beneficio que no podía perder",
    "la política de oficina cambió tres veces en un año",
    "mi equipo entero está en otras ciudades y la oficina era una videollamada con peores sillas",
    "el mandato de presencia decidió esto por mí",
    "la flexibilidad era parte del trato cuando entré y el trato cambió",
    "el viaje diario costaba más que el aumento que nunca llegó",
  ],
  quitRegret: [
    "una parte de mí desearía haberse quedado un año más",
    "me pregunto más de lo que esperaba si me fui demasiado pronto",
    "hay arrepentimiento de verdad mezclado con el alivio",
    "extraño a la gente más de lo que pensaba y eso duele",
    "si el momento hubiera sido otro creo que me habría quedado",
  ],
  quitIntent: [
    "tenía que salir antes de que fuera peor",
    "renunciar era la única opción que quedaba sobre la mesa",
    "no podía quedarme ni un trimestre más",
    "me fui antes de que me costara algo más que un empleo",
    "la decisión de renunciar se tomó sola al final",
    "presenté mi renuncia la mañana siguiente del anuncio",
  ],
};
const FILLER_ES = [
  "el equipo en sí era muy amable y lo voy a extrañar",
  "los compañeros hicieron llevaderos los momentos duros",
  "la salida fue tranquila y respetuosa, eso lo agradezco",
  "aprendí mucho del oficio en esta empresa",
  "los clientes eran la mejor parte del trabajo",
  "no hay una sola razón, simplemente se terminó el capítulo",
  "era hora de algo nuevo para mí y para mi familia",
  "les deseo lo mejor a los que se quedan",
];

const CONNECTIVES = [
  " and on top of that ",
  " — and honestly, ",
  ". Also, ",
  ". Beyond that, ",
  " and at the same time ",
  ". Meanwhile, ",
  ", plus ",
  ". To be fair, ",
];

// Openers diversify short responses (collision control: without them,
// single-clause rows would collide into accidental dup/bot groups far beyond
// the planted dirt rates — see compose()).
const OPENERS = [
  "Honestly, ",
  "Look — ",
  "Short version: ",
  "If I am being candid, ",
  "Plainly put, ",
  "For what it is worth, ",
  "Since you asked: ",
  "Bottom line: ",
  "Truthfully, ",
  "In the end, ",
  "Where to start — ",
  "Simply put, ",
  "After five rounds of reflection: ",
  "Off the record but on the form: ",
];
const OPENERS_ES = [
  "Honestamente, ",
  "La verdad, ",
  "En resumen: ",
  "Siendo sincero, ",
  "Al final, ",
  "Para ser justos, ",
];
const CONNECTIVES_ES = [
  " y además ",
  ". También, ",
  " y al mismo tiempo ",
  ". Por otro lado, ",
  ", y encima ",
];

const JUNK_TEXTS = ["n/a", "asdf", ".", "none", "nothing", "-", "idk", "asdfasdf", "x"];

// The 7-row bot burst: identical mid-length text (≥6 tokens so junk.scan
// classifies the group as "bot", not "dup"), carrying no planted vocabulary.
const BOT_TEXT = "Please refer to my previous answer regarding the exit process for full details.";

// ------------------------------------------------------------- composition

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// Compose a response from the row's theme flags. Multi-theme rows join one
// clause per active theme with natural connectives; no-theme rows draw two
// filler clauses; short rows get openers/tails for register + length variety.
//
// Collision control: identical texts MUST imply identical theme flags (the
// MockModel oracle is keyed on unit text), which holds because clause banks
// are vocabulary-disjoint per theme and a text contains exactly one clause
// per active theme. But identical texts also read as duplicates to the junk
// scanner, so short compositions are diversified (openers, near-mandatory
// tails on single-clause rows, two-clause filler) until accidental repeats
// are rare; the PLANTED ~1% dupes + 7-row bot burst stay the dominant dirt.
function compose(rand, flags, lang) {
  const banks = lang === "es" ? CLAUSES_ES : CLAUSES;
  const filler = lang === "es" ? FILLER_ES : FILLER;
  const connectives = lang === "es" ? CONNECTIVES_ES : CONNECTIVES;
  const openers = lang === "es" ? OPENERS_ES : OPENERS;

  const parts = [];
  for (const theme of THEME_NAMES) {
    if (flags[theme]) parts.push(pick(rand, banks[theme]));
  }
  if (flags.quitIntent) parts.push(pick(rand, banks.quitIntent));
  const themed = parts.length > 0;
  if (!themed) {
    parts.push(pick(rand, filler));
    parts.push(pick(rand, filler));
  }

  let text = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const joiner = pick(rand, connectives);
    text += joiner + parts[i];
  }
  // filler tail: near-mandatory on single-clause themed rows (entropy),
  // occasional on two-part rows (length variety toward 5–120 words)
  const single = themed && parts.length === 1;
  const tailP = single ? 0.85 : parts.length <= 2 ? 0.25 : 0;
  if (rand() < tailP) {
    text += pick(rand, connectives) + pick(rand, filler);
  }
  if (rand() < (single ? 0.6 : 0.45)) text = pick(rand, openers) + text;
  text = cap(text.replaceAll(". .", ".").trim());
  if (!/[.!?]$/.test(text)) text += ".";
  // floor at 5 words — terse registers stay, sub-survey fragments do not
  if (text.split(/\s+/).length < 5) {
    text = text.replace(/[.!?]$/, "") + pick(rand, connectives) + pick(rand, filler);
    text = cap(text.trim());
    if (!/[.!?]$/.test(text)) text += ".";
  }
  return text;
}

// ------------------------------------------------------------- generation

// generate({n, seed}) → {rows, oracle, stats}
//   rows:   [{respondent_id, dept, tenure_years, role_level, region,
//             exit_date, satisfaction, response}]
//   oracle: {respondent_id → {pay, management, workload, growth, remote,
//            quitRegret, quitIntent}}  — EXACT planted truth per row
//   stats:  realized theme rates + dirt counts
export function generate({ n = N_ROWS, seed = SEED } = {}) {
  const rand = mulberry32(seed);
  const rows = [];
  const flagsByRow = [];
  const langByRow = [];

  for (let i = 0; i < n; i++) {
    const meta = {
      respondent_id: `R-${1000 + i}`,
      dept: pickWeighted(rand, DEPTS),
      tenure_years: tenure(rand),
      role_level: pickWeighted(rand, ROLES),
      region: pickWeighted(rand, REGIONS),
      exit_date: exitDate(rand),
      satisfaction: pickWeighted(rand, SATISFACTION),
    };
    const flags = {};
    for (const theme of THEME_NAMES) flags[theme] = rand() < THEME_PROBS[theme](meta);
    flags.quitIntent = rand() < quitIntentProb(meta);

    const lang = rand() < 0.03 ? "es" : "en";
    const junk = rand() < 0.02;
    let response;
    if (junk) {
      for (const f of ALL_FLAGS) flags[f] = false;
      response = pick(rand, JUNK_TEXTS);
    } else {
      response = compose(rand, flags, lang);
    }
    rows.push({ ...meta, response });
    flagsByRow.push(flags);
    langByRow.push(junk ? "junk" : lang);
  }

  // ---- ~1% exact duplicates: a later row copies an earlier non-junk row's
  // text AND flags (identical text ⟹ identical truth, so the text-keyed
  // MockModel oracle stays well-defined).
  const isJunkText = (t) => JUNK_TEXTS.includes(t);
  const dupCount = Math.round(n * 0.01);
  for (let d = 0; d < dupCount; d++) {
    const target = 100 + Math.floor(rand() * (n - 100));
    const source = Math.floor(rand() * target);
    if (isJunkText(rows[source].response) || isJunkText(rows[target].response)) continue;
    rows[target].response = rows[source].response;
    flagsByRow[target] = { ...flagsByRow[source] };
    langByRow[target] = langByRow[source];
  }

  // ---- one 7-row bot burst (consecutive identical ≥6-token text, no themes)
  const botStart = 300 + Math.floor(rand() * Math.max(1, n - 600));
  for (let b = botStart; b < Math.min(n, botStart + 7); b++) {
    rows[b].response = BOT_TEXT;
    flagsByRow[b] = Object.fromEntries(ALL_FLAGS.map((f) => [f, false]));
    langByRow[b] = "en";
  }

  // ---- oracle + realized stats
  const oracle = {};
  const stats = {
    n,
    themes: {},
    junkRows: rows.filter((r) => isJunkText(r.response)).length,
    botRows: rows.filter((r) => r.response === BOT_TEXT).length,
    spanishRows: langByRow.filter((l) => l === "es").length,
  };
  for (let i = 0; i < n; i++) oracle[rows[i].respondent_id] = flagsByRow[i];
  for (const f of ALL_FLAGS) {
    const realized = flagsByRow.filter((x) => x[f]).length / n;
    stats.themes[f] = {
      ...(THEME_TARGETS[f] !== undefined ? { target: THEME_TARGETS[f] } : {}),
      realized: Math.round(realized * 1e4) / 1e4,
    };
  }
  return { rows, oracle, stats };
}

// ------------------------------------------------------------- CSV writer

const COLUMNS = ["respondent_id", "dept", "tenure_years", "role_level", "region", "exit_date", "satisfaction", "response"];

function csvField(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvField(r[c])).join(","));
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------- main

const here = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const { rows, oracle, stats } = generate({});
  const csv = toCsv(rows);
  const oracleDoc = {
    generated: `demo/generate.js — seeded mulberry32, seed ${SEED}; re-running regenerates byte-identical files (no timestamps)`,
    seed: SEED,
    n: rows.length,
    flags: ALL_FLAGS,
    themes: stats.themes,
    dirt: { junkRows: stats.junkRows, botRows: stats.botRows, spanishRows: stats.spanishRows },
    rows: oracle,
  };
  writeFileSync(path.join(here, "techcorp-exit-survey.csv"), csv, "utf8");
  writeFileSync(path.join(here, "oracle.json"), JSON.stringify(oracleDoc, null, 1) + "\n", "utf8");
  console.log(`wrote demo/techcorp-exit-survey.csv (${rows.length} rows, ${(csv.length / 1024).toFixed(0)} KB)`);
  console.log(`wrote demo/oracle.json`);
  console.log("realized theme rates vs targets:");
  for (const [f, s] of Object.entries(stats.themes)) {
    console.log(`  ${f.padEnd(11)} realized ${s.realized.toFixed(4)}${s.target !== undefined ? `  (target ${s.target})` : ""}`);
  }
  console.log(`dirt: junk=${stats.junkRows} bot=${stats.botRows} spanish≈${stats.spanishRows}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
