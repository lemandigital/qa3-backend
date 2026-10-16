import {
  BedrockRuntimeClient,
  ConverseCommand,
  ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// Inicjalizacja klienta AWS Bedrock (wykonuje się raz przy zimnym starcie Lambdy)
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || "eu-central-1",
});

// // Model Claude 3 Haiku - idealny stosunek ceny do prędkości
// const MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";

// Model Claude Haiku 5.5 - idealny stosunek ceny do prędkości
const MODEL_ID = "eu.amazon.nova-lite-v1:0";

/**
 * Definicja narzędzia (Tool Configuration) wymuszająca zwrot idealnego obiektu JSON.
 * Zamiast prosić model "zwróć mi JSON", mówimy mu: "Musisz użyć tej funkcji,
 * a oto parametry, których wymaga ta funkcja".
 */
const toolConfiguration: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "generate_application_variants",
        description:
          "Generates the final job application messages in 3 formats.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              sms_variant: {
                type: "string",
                description:
                  "The SMS version of the application. Very short, max 160 characters.",
              },
              whatsapp_variant: {
                type: "string",
                description:
                  "The WhatsApp version. Slightly warmer, use 1-2 emojis.",
              },
              email_subject: {
                type: "string",
                description: "The subject line for the email application.",
              },
              email_body: {
                type: "string",
                description: "The main body of the email. Formal but short.",
              },
            },
            required: [
              "sms_variant",
              "whatsapp_variant",
              "email_subject",
              "email_body",
            ],
          },
        },
      },
    },
  ],
  toolChoice: {
    tool: { name: "generate_application_variants" },
  },
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    // 1. Parsowanie payloadu wejściowego z frontendu
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing request body" }),
      };
    }

    // W produkcji warto tutaj dodać bibliotekę walidacyjną, np. Zod
    const requestData = JSON.parse(event.body);
    const { meta, payload } = requestData;

    // 2. Konstrukcja Promptu Systemowego (Kontekst)
    const systemPrompt = `
You are an expert Swiss HR assistant specializing in blue-collar and service jobs (Romandie).
Generate localized, perfectly polite job application messages in ${meta.targetLang === "fr" ? "French" : "German"}.
CRITICAL RULES:
- Translate local context accurately (e.g., permit_B means "Permis B", clean_record means "casier judiciaire vierge").
- Keep vocabulary straightforward and professional. No corporate fluff.
- If a name is missing, adapt the text naturally. Do NOT use placeholders like [Name].
    `.trim();

    // 3. Konstrukcja Promptu Użytkownika (Wstrzyknięcie zmiennych przez XML)
    // Bezpieczne wstrzykiwanie zmiennych z payloadu chroni przed Prompt Injection
    const userPrompt = `
Please generate the application messages based on this profile:

<candidate_profile>
  <job_category>${payload.jobCategory}</job_category>
  ${payload.jobTitleCustom ? `<custom_title>${payload.jobTitleCustom}</custom_title>` : ""}
  <experience>${payload.experience.replace(/_/g, " ")}</experience>
  ${payload.permitStatus ? `<permit_status>${payload.permitStatus}</permit_status>` : ""}
  <availability>${payload.availability.replace(/_/g, " ")}</availability>
  ${payload.mobility ? `<mobility>${payload.mobility}</mobility>` : ""}
  ${payload.ownTools ? `<own_tools>${payload.ownTools}</own_tools>` : ""}
  ${payload.trustedDocs ? `<certifications>${payload.trustedDocs.join(", ")}</certifications>` : ""}
  ${payload.firstName ? `<first_name>${payload.firstName}</first_name>` : ""}
</candidate_profile>
    `.trim();

    // 4. Wywołanie AWS Bedrock (Converse API)
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: userPrompt }],
        },
      ],
      toolConfig: toolConfiguration,
      // Temperatura 0.2 zapewnia powtarzalność, gramatyczną poprawność i mniejszą "kreatywną halucynację"
      inferenceConfig: { temperature: 0.2 },
    });

    const response = await bedrockClient.send(command);

    // 5. Ekstrakcja wygenerowanego JSON-a
    // Ponieważ wymusiliśmy użycie narzędzia, odpowiedź znajduje się w bloku `toolUse`
    const messageContent = response.output?.message?.content;
    const toolUseBlock = messageContent?.find(
      (block) => block.toolUse !== undefined,
    );

    if (!toolUseBlock || !toolUseBlock.toolUse) {
      throw new Error("Bedrock did not return the expected ToolUse block.");
    }

    const generatedVariants = toolUseBlock.toolUse.input;

    // 6. Zwrócenie sukcesu do API Gateway
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // API Gateway zarządza CORS (OPTIONS preflight),
        // ale dodanie tych nagłówków do odpowiedzi 200 jest dobrą praktyką.
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(generatedVariants),
    };
  } catch (error) {
    console.error("Error generating application variants:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to generate messages." }),
    };
  }
};
