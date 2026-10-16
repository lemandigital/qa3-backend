import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as path from "path";

export class Qa3BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==========================================
    // 1. AWS LAMBDA (Logika Biznesowa)
    // ==========================================

    // Używamy NodejsFunction, co pozwala pisać kod Lambdy w TypeScript.
    // CDK automatycznie użyje 'esbuild' do zbudowania i zminifikowania pliku podczas wdrożenia.
    const generateMessageLambda = new nodejs.NodejsFunction(
      this,
      "GenerateMessageFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: path.join(__dirname, "../src/lambda/generate.ts"), // Ścieżka do kodu backendu
        handler: "handler",
        memorySize: 256,
        timeout: cdk.Duration.seconds(15), // Bedrock Claude Haiku odpowiada zazwyczaj w 2-3 sekundy
        environment: {
          // Przekazanie regionu Bedrocka, jeśli jest inny niż region API
          BEDROCK_REGION: "eu-central-1",
        },
        bundling: {
          minify: true,
          sourceMap: false,
        },
      },
    );

    // ==========================================
    // 2. IAM POLICIES (Model Bezpieczeństwa)
    // ==========================================

    // Definiujemy precyzyjną polisę pozwalającą Lambdzie TYLKO na wywoływanie
    // konkretnego modelu Anthropic Claude 5.5 Haiku w usłudze Amazon Bedrock.
    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:eu-central-1:261175718378:inference-profile/eu.amazon.nova-lite-v1:0`,
        `arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0`,
      ],
    });

    // Podpięcie polisy do roli, którą wykonuje Lambda
    generateMessageLambda.addToRolePolicy(bedrockPolicy);

    // ==========================================
    // 3. API KEY AUTHORIZER (Lambda Authorizer)
    // ==========================================

    // Klucz API generowany losowo przez Secrets Manager - nie trafia do repozytorium ani do szablonu CloudFormation
    const apiKeySecret = new secretsmanager.Secret(this, "ApiKeySecret", {
      description: "Klucz API dla QA3 HTTP API (nagłówek x-api-key)",
      generateSecretString: {
        passwordLength: 40,
        excludePunctuation: true,
      },
    });

    const authorizerLambda = new nodejs.NodejsFunction(
      this,
      "ApiKeyAuthorizerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: path.join(__dirname, "../src/lambda/authorizer.ts"),
        handler: "handler",
        memorySize: 128,
        timeout: cdk.Duration.seconds(5),
        environment: {
          API_KEY_SECRET_ARN: apiKeySecret.secretArn,
        },
        bundling: {
          minify: true,
          sourceMap: false,
        },
      },
    );

    // Authorizer może tylko odczytać ten jeden sekret
    apiKeySecret.grantRead(authorizerLambda);

    const apiKeyAuthorizer = new authorizers.HttpLambdaAuthorizer(
      "ApiKeyAuthorizer",
      authorizerLambda,
      {
        // Prosta odpowiedź { isAuthorized: boolean } zamiast polityki IAM
        responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
        // Brak nagłówka = API Gateway od razu zwraca 401, bez wywoływania Lambdy
        identitySource: ["$request.header.x-api-key"],
        // Wynik autoryzacji jest cache'owany per wartość klucza
        resultsCacheTtl: cdk.Duration.minutes(5),
      },
    );

    // ==========================================
    // 4. API GATEWAY (HTTP API - Zero-Friction Endpoint)
    // ==========================================

    // Konfiguracja integracji API z naszą Lambdą
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "GenerateMessageIntegration",
      generateMessageLambda,
    );

    // Tworzymy HTTP API (tańsze i o niższych opóźnieniach niż REST API)
    const httpApi = new apigwv2.HttpApi(this, "Qa3HttpApi", {
      apiName: "QA3-API",
      description: "API dla generatora aplikacji o pracę (Zero-Friction) - QA3",
      corsPreflight: {
        // W produkcji zmień allowOrigins na konkretną domenę, np. ['https://twoja-domena.ch']
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Definiujemy routing: POST /api/v1/generate trafia do Lambdy (tylko z poprawnym kluczem API)
    httpApi.addRoutes({
      path: "/api/v1/generate",
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: apiKeyAuthorizer,
    });

    // ==========================================
    // 5. OUTPUTS (Zwracanie danych po wdrożeniu)
    // ==========================================

    // Po wykonaniu 'cdk deploy' konsola wyświetli gotowy adres URL do wklejenia w Next.js
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: `${httpApi.apiEndpoint}/api/v1/generate`,
      description: "Adres URL Endpointu API do wywołania z frontendu (Next.js)",
    });

    // Wartość klucza: aws secretsmanager get-secret-value --secret-id <ARN> --query SecretString --output text
    new cdk.CfnOutput(this, "ApiKeySecretArn", {
      value: apiKeySecret.secretArn,
      description: "ARN sekretu z kluczem API (nagłówek x-api-key)",
    });
  }
}
