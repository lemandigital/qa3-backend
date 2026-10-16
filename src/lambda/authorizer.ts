import { createHash, timingSafeEqual } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from "aws-lambda";

// Inicjalizacja klienta Secrets Manager (wykonuje się raz przy zimnym starcie Lambdy)
const secretsClient = new SecretsManagerClient({});

// Hash oczekiwanego klucza API trzymany w pamięci między wywołaniami,
// żeby nie odpytywać Secrets Managera przy każdym żądaniu.
let expectedKeyHash: Promise<Buffer> | undefined;

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

const loadExpectedKeyHash = async (): Promise<Buffer> => {
  const { SecretString } = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.API_KEY_SECRET_ARN }),
  );

  if (!SecretString) {
    throw new Error("API key secret is empty.");
  }

  return sha256(SecretString);
};

/**
 * Lambda Authorizer dla HTTP API (payload 2.0, "simple responses").
 * Sprawdza nagłówek `x-api-key` i zwraca jedynie { isAuthorized: true | false }.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> => {
  // HTTP API przekazuje nazwy nagłówków małymi literami
  const providedKey = event.headers?.["x-api-key"];

  if (!providedKey) {
    return { isAuthorized: false };
  }

  // Przy błędzie pobrania sekretu czyścimy cache, aby kolejne wywołanie spróbowało ponownie
  expectedKeyHash ??= loadExpectedKeyHash().catch((error) => {
    expectedKeyHash = undefined;
    throw error;
  });

  // Porównujemy hashe o stałej długości w czasie stałym (ochrona przed timing attack)
  return {
    isAuthorized: timingSafeEqual(sha256(providedKey), await expectedKeyHash),
  };
};
