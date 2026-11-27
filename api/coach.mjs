const schema = {
  type: "object",
  additionalProperties: false,
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

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end("QuotaZero Coach API attiva con Google Gemini. Il servizio accetta richieste POST.");
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Metodo non consentito." });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(res, 503, { error: "Manca GEMINI_API_KEY nelle variabili ambiente di Vercel." });

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};
    const message = String(body.message || "").trim().slice(0, 2000);
    if (!message) return json(res, 400, { error: "Scrivi una richiesta." });

    const previous = body.context && typeof body.context === "object" ? JSON.stringify(body.context).slice(0, 5000) : "Nessun contesto precedente.";
    const instructions = [
      "Sei il Coach AI di QuotaZero, assistente per pianificare percorsi ciclistici in Italia. Interpreta messaggi in italiano e segui i messaggi precedenti. Rispondi esclusivamente secondo lo schema JSON richiesto.",
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

    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];
    let response;
    let data;
    let lastFailure = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
          signal: AbortSignal.timeout(12000),
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: "user", parts: [{ text: message }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: schema,
              maxOutputTokens: 1200
            }
          })
        });

        data = await response.json();
        if (response.ok) break;

        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        const detail = String(data?.error?.message || "Errore non specificato").slice(0, 500);
        lastFailure = { status: response.status, message: detail };
        if (!retryable || i === models.length - 1) {
          console.error("Gemini API error:", model, response.status, detail);
          return json(res, 502, { error: "Errore Google Gemini (modello " + model + ", HTTP " + response.status + "): " + detail });
        }
        console.warn("Gemini model unavailable; trying fallback:", model, response.status);
      } catch (error) {
        lastFailure = { timeout: error?.name === "TimeoutError" || error?.name === "AbortError", message: String(error?.message || error) };
        console.warn("Gemini request failed; trying fallback:", model, lastFailure.message);
        if (i === models.length - 1) {
          return json(res, lastFailure.timeout ? 504 : 502, {
            error: lastFailure.timeout
              ? "Anche il modello Gemini di riserva è troppo lento. Riprova tra poco."
              : "Connessione a Google Gemini non riuscita: " + lastFailure.message.slice(0, 200)
          });
        }
      }
    }

    if (!response?.ok || !data) {
      return json(res, 502, { error: "Google Gemini non ha restituito una risposta. Riprova tra poco." });
    }

    const output = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!output) {
      console.error("Gemini returned no text:", JSON.stringify(data.promptFeedback || data.candidates?.[0]?.finishReason || {}));
      return json(res, 502, { error: "Gemini non ha prodotto una risposta valida. Riprova." });
    }

    let intent;
    try {
      intent = JSON.parse(output);
    } catch (parseError) {
      const finishReason = data.candidates?.[0]?.finishReason || "sconosciuto";
      console.error("Gemini returned invalid JSON:", finishReason, output.slice(0, 1000));
      return json(res, 502, {
        error: finishReason === "MAX_TOKENS"
          ? "La risposta di Gemini è stata interrotta. Riprova con una richiesta più breve."
          : "Gemini ha restituito una risposta non valida. Riprova tra poco."
      });
    }
    if (!["route", "clarify", "chat"].includes(intent.action) || !Array.isArray(intent.via_locations)) {
      return json(res, 502, { error: "Risposta AI non valida." });
    }
    return json(res, 200, intent);
  } catch (error) {
    console.error("QuotaZero Gemini error:", error?.name || "", error?.message || error);
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const detail = String(error?.message || "Errore senza dettagli").slice(0, 300);
    return json(res, timedOut ? 504 : 500, {
      error: timedOut
        ? "Google Gemini sta impiegando troppo tempo. Riprova tra poco."
        : "Errore interno QuotaZero (" + String(error?.name || "Error") + "): " + detail
    });
  }
}
