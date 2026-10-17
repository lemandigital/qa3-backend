import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as path from "path";

// Domena API (DNS w Cloudflare - rekordy dodawane ręcznie, patrz outputy stacków)
const API_DOMAIN = "api.qa3.ch";

// Ścieżka endpointu generowania - wspólna dla routingu API Gateway i reguły WAF
const GENERATE_PATH = "/api/v1/generate";

// Rate limit per IP (WAF dopuszcza okna 60, 120, 300 lub 600 sekund)
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 300;

// Nagłówek z IP klienta końcowego, ustawiany przez serwer Next.js
const CLIENT_IP_HEADER = "x-client-ip";

/**
 * Web ACL (scope: CLOUDFRONT) i certyfikat ACM dla CloudFront muszą powstać w us-east-1,
 * dlatego są osobnym stackiem, a trafiają do Qa3BackendStack przez crossRegionReferences.
 */
export class Qa3WafStack extends cdk.Stack {
  public readonly webAclArn: string;
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Żądania objęte limitem: POST na endpoint generowania (preflight OPTIONS z przeglądarki nie zużywa limitu)
    const generateRequestStatements: wafv2.CfnWebACL.StatementProperty[] = [
      {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          searchString: GENERATE_PATH,
          positionalConstraint: "STARTS_WITH",
          // Dekodowanie URL, żeby nie dało się obejść reguły zakodowaną ścieżką (np. /api/v1/%67enerate)
          textTransformations: [{ priority: 0, type: "URL_DECODE" }],
        },
      },
      {
        byteMatchStatement: {
          fieldToMatch: { method: {} },
          searchString: "POST",
          positionalConstraint: "EXACTLY",
          textTransformations: [{ priority: 0, type: "NONE" }],
        },
      },
    ];

    // Dopasowuje żądania, które mają nagłówek x-client-ip (sprawdzamy nazwę nagłówka, nie wartość)
    const hasClientIpHeader: wafv2.CfnWebACL.StatementProperty = {
      byteMatchStatement: {
        fieldToMatch: {
          headers: {
            matchPattern: { includedHeaders: [CLIENT_IP_HEADER] },
            matchScope: "KEY",
            oversizeHandling: "CONTINUE",
          },
        },
        searchString: CLIENT_IP_HEADER,
        positionalConstraint: "EXACTLY",
        textTransformations: [{ priority: 0, type: "LOWERCASE" }],
      },
    };

    // Wspólna akcja obu reguł: 429 z JSON-em i Retry-After
    const tooManyRequestsAction: wafv2.CfnWebACL.RuleActionProperty = {
      block: {
        customResponse: {
          responseCode: 429,
          customResponseBodyKey: "TooManyRequests",
          responseHeaders: [
            { name: "Retry-After", value: String(RATE_LIMIT_WINDOW_SECONDS) },
            // Bez nagłówka CORS przeglądarka nie pozwoli frontendowi odczytać odpowiedzi 429
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
        },
      },
    };

    const webAcl = new wafv2.CfnWebACL(this, "Qa3WebAcl", {
      name: "qa3-api-web-acl",
      scope: "CLOUDFRONT",
      // Domyślnie przepuszczamy ruch - blokuje tylko reguła rate limitu
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "qa3-api-web-acl",
        sampledRequestsEnabled: true,
      },
      // Treść odpowiedzi 429 zwracanej przez WAF
      customResponseBodies: {
        TooManyRequests: {
          contentType: "APPLICATION_JSON",
          content: JSON.stringify({
            error: "Too Many Requests",
            message: "Rate limit exceeded. Please try again later.",
          }),
        },
      },
      rules: [
        {
          name: "RateLimitGenerateByClientIp",
          priority: 0,
          statement: {
            rateBasedStatement: {
              limit: RATE_LIMIT_REQUESTS,
              evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
              // Liczymy per IP klienta z nagłówka x-client-ip (WAF bierze pierwszy adres z nagłówka)
              aggregateKeyType: "FORWARDED_IP",
              forwardedIpConfig: {
                headerName: CLIENT_IP_HEADER,
                // Niepoprawne IP w nagłówku = od razu 429, inaczej dałoby się obejść limit dowolną wartością
                fallbackBehavior: "MATCH",
              },
              scopeDownStatement: {
                andStatement: { statements: generateRequestStatements },
              },
            },
          },
          action: tooManyRequestsAction,
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "qa3-rate-limit-generate-client-ip",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitGenerateBySourceIp",
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: RATE_LIMIT_REQUESTS,
              evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
              // Gdy brak nagłówka x-client-ip, WAF pomija regułę powyżej - wtedy liczymy per IP nadawcy
              aggregateKeyType: "IP",
              scopeDownStatement: {
                andStatement: {
                  statements: [
                    ...generateRequestStatements,
                    { notStatement: { statement: hasClientIpHeader } },
                  ],
                },
              },
            },
          },
          action: tooManyRequestsAction,
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "qa3-rate-limit-generate-source-ip",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;

    // Certyfikat SSL dla api.qa3.ch. Walidacja DNS: deploy czeka, aż rekord CNAME z ACM
    // zostanie dodany w Cloudflare (nazwa i wartość są w zdarzeniach CloudFormation / konsoli ACM).
    // Rekord musi zostać na stałe - ACM używa go do automatycznego odnawiania certyfikatu.
    this.certificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: API_DOMAIN,
      validation: acm.CertificateValidation.fromDns(),
    });
  }
}

export interface Qa3BackendStackProps extends cdk.StackProps {
  // ARN Web ACL z Qa3WafStack (us-east-1)
  webAclArn: string;
  // Certyfikat dla API_DOMAIN z Qa3WafStack (us-east-1)
  certificate: acm.ICertificate;
}

export class Qa3BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Qa3BackendStackProps) {
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
      path: GENERATE_PATH,
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: apiKeyAuthorizer,
    });

    // ==========================================
    // 5. CLOUDFRONT + WAF (Rate limiting przed API Gateway)
    // ==========================================

    // HTTP API nie obsługuje WAF bezpośrednio, dlatego ruch idzie przez CloudFront z podpiętym Web ACL
    const distribution = new cloudfront.Distribution(this, "Qa3Distribution", {
      comment: "QA3 API - CloudFront + WAF przed HTTP API",
      webAclId: props.webAclArn,
      domainNames: [API_DOMAIN],
      certificate: props.certificate,
      // Najtańsza klasa - lokalizacje tylko w Ameryce Północnej i Europie
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          `${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`,
        ),
        // HTTPS_ONLY zamiast przekierowania - redirect zgubiłby body żądania POST
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Odpowiedzi API nie są cache'owane
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Przekazujemy wszystkie nagłówki (w tym x-api-key i Origin dla CORS) poza Host, którego wymaga API Gateway
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    // ==========================================
    // 6. OUTPUTS (Zwracanie danych po wdrożeniu)
    // ==========================================

    // Po wykonaniu 'cdk deploy' konsola wyświetli gotowy adres URL do wklejenia w Next.js
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: `https://${API_DOMAIN}${GENERATE_PATH}`,
      description:
        "Adres URL Endpointu API (przez CloudFront + WAF) do wywołania z frontendu (Next.js)",
    });

    // W Cloudflare: CNAME api -> ta wartość, z wyłączonym proxy (DNS only)
    new cdk.CfnOutput(this, "CloudFrontDomainName", {
      value: distribution.distributionDomainName,
      description: `Cel rekordu CNAME ${API_DOMAIN} w Cloudflare (DNS only)`,
    });

    // Wartość klucza: aws secretsmanager get-secret-value --secret-id <ARN> --query SecretString --output text
    new cdk.CfnOutput(this, "ApiKeySecretArn", {
      value: apiKeySecret.secretArn,
      description: "ARN sekretu z kluczem API (nagłówek x-api-key)",
    });
  }
}
