const schema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["route", "clarify", "chat"] },
    reply: { type: "string" },
    start_location: { anyOf: [{ type: "string" }, { type: "null" }] },
    via_locations: { type: "array", items: { type: "string" } },
    end_location: { anyOf: [{ type: "string" }, { type: "null" }] },
    route_type: { type: "string", enum: ["loop", "point_to_point", "none"] },
    discipline: { type: "string", enum: ["road", "gravel", "mtb"] },
    target_km: { anyOf: [{ type: "number" }, { type: "null" }] },
    max_ascent_m: { anyOf: [{ type: "number" }, { type: "null" }] },
    clarification: { anyOf: [{ type: "string" }, { type: "null" }] }
  },
  required: ["action", "reply", "start_location", "via_locations", "end_location", "route_type", "discipline", "target_km", "max_ascent_m", "clarification"]
};

export default async function handler(request) {
  if (request.method === "GET") return new Response("QuotaZero Coach API attiva. Il servizio accetta richieste POST.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return Response.json({ error: "Metodo non consentito." }, { status: 405, headers: { allow: "POST" } });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: "Il Coach AI non è ancora configurato: manca OPENAI_API_KEY su Vercel." }, { status: 503 });
  try {
    const body = await request.json();
    const message = String(body.message || "").trim().slice(0, 2000);
    if (!message) return Response.json({ error: "Scrivi una richiesta." }, { status: 400 });
    const previous = body.context && typeof body.context === "object" ? JSON.stringify(body.context).slice(0, 5000) : "Nessun contesto precedente.";
    const instructions = [
      "Sei il Coach AI di QuotaZero, assistente per pianificare percorsi ciclistici in Italia. Interpreta messaggi in italiano e segui i messaggi precedenti. Rispondi esclusivamente secondo lo schema JSON.",
      "Non inventare coordinate, strade, distanze o dislivelli: il tracciato sarà calcolato da un motore cartografico separato.",
      "Se l’utente corregge una località, aggiorna il contesto mantenendo partenza, disciplina e vincoli già validi.",
      "Fondamentale: «giro ad anello da A a B» significa partenza da A, passaggio/waypoint B e ritorno ad A: route_type=loop, start_location=A, via_locations=[B], end_location=null.",
      "«Da A a B» senza richiesta di anello significa point_to_point, partenza A e arrivo B.",
      "Per un anello senza località di passaggio non inventare un percorso: chiedi quale luogo/passaggio desidera includere.",
      "Se mancano informazioni indispensabili o un luogo è ambiguo, action=clarify e fai una sola domanda precisa; non proporre un percorso.",
      "Monte Livata, quando inteso come montagna/località turistica, è presso Subiaco nei Monti Simbruini, Città metropolitana di Roma; NON è Via Monte Livata a Latina. Restituisci «Monte Livata, Subiaco, Roma, Lazio, Italia».",
      "Montelanico è il comune in provincia di Roma, Lazio. Comprendi strada, gravel, MTB; se non specificato usa road. Estrai chilometri e limite dislivello solo se espressi chiaramente, altrimenti null.",
      "action=route solo quando partenza e tipo percorso sono sufficientemente chiari. action=chat per domande generali che non chiedono di creare/modificare un percorso.",
      "Nel campo reply scrivi una frase breve e naturale in italiano. Se action=clarify, inserisci la domanda anche in clarification.",
      "Contesto percorso precedente: " + previous
    ].join("\n");
    const response = await fetch("https://api.openai.com/v1/responses", {
      signal: AbortSignal.timeout(25000),
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", instructions, input: message, text: { format: { type: "json_schema", name: "quotazero_coach_intent", strict: true, schema } }, max_output_tokens: 500, store: false })
    });
    const data = await response.json();
    if (!response.ok) { console.error("OpenAI API error:", response.status, data?.error?.message || "unknown"); return Response.json({ error: "Il servizio AI ha restituito un errore. Controlla la configurazione della chiave OpenAI." }, { status: 502 }); }
    const output = (data.output || []).flatMap(item => item.content || []).find(item => item.type === "output_text")?.text;
    if (!output) return Response.json({ error: "Il Coach non ha prodotto una risposta valida. Riprova." }, { status: 502 });
    const intent = JSON.parse(output);
    if (!["route", "clarify", "chat"].includes(intent.action) || !Array.isArray(intent.via_locations)) return Response.json({ error: "Risposta AI non valida." }, { status: 502 });
    return Response.json(intent, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { console.error("QuotaZero coach error:", error?.name || "", error?.message || error); const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError"; return Response.json({ error: timedOut ? "Il servizio AI sta impiegando troppo tempo. Riprova tra poco." : "Non riesco a elaborare la richiesta in questo momento." }, { status: timedOut ? 504 : 500 }); }
}