# The API is a Lambda function URL with AWS_IAM auth: it answers only signed requests. CloudFront signs every
# request it forwards, with origin access control (below); otherwise only principals in this account with Lambda
# invoke permissions can call it. The API Lambda's reserved concurrency caps it.
# Clients send their credential in X-Qsb-Authorization, since the signature takes Authorization, and the
# x-amz-content-sha256 of each body, which origin access control requires (docs/API.md#request-headers).
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${var.name}-api"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
# CloudFront needs both actions on the function, and only for this distribution.
resource "aws_lambda_permission" "api_url" {
  statement_id           = "CloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.web.arn
  function_url_auth_type = "AWS_IAM"
}
resource "aws_lambda_permission" "api_invoke" {
  statement_id             = "CloudFrontInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.web.arn
  invoked_via_function_url = true
}
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security"
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      override                = true
    }
  }
}
# AWS managed policies, resolved at plan time: a wrong name or ID now fails `terraform plan` instead of
# CreateDistribution mid-apply, as a mistyped hard-coded ID once did. The deploy roles may list and get cache
# policies but only get origin request policies, so AllViewerExceptHostHeader is looked up by its ID.
data "aws_cloudfront_cache_policy" "caching_optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_cache_policy" "caching_disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" { id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" }
resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  is_ipv6_enabled     = true
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }
  origin {
    # The function URL is https://<id>.lambda-url.<region>.on.aws/: CloudFront takes its host.
    domain_name              = split("/", aws_lambda_function_url.api.function_url)[2]
    origin_id                = "api"
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed CachingOptimized.
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # Managed CachingDisabled and AllViewerExceptHostHeader: keep cookies, query and X-Qsb-Authorization (origin
    # access control replaces Authorization with its signature).
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }
  # /v1 is the stable API prefix; the API serves it with the same handlers as /api. Keep it identical.
  ordered_cache_behavior {
    path_pattern               = "/v1/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}
# The app's origin, which the API names in its sign-in challenge and allows for CORS (server/app.ts). It can't be
# in the API Lambda's environment: CloudFront's API origin is the function URL, which belongs to that function, so
# the function can't depend on CloudFront too. Terraform writes it here once the distribution exists. The app's
# roles can't write SYSTEM# rows (policies/app-records.json); the deploy role and qsb-operator, which manage the
# table, can.
resource "aws_dynamodb_table_item" "app_origin" {
  table_name = aws_dynamodb_table.records.name
  hash_key   = aws_dynamodb_table.records.hash_key
  range_key  = aws_dynamodb_table.records.range_key
  item = jsonencode({
    pk      = { S = "SYSTEM#DEPLOYMENT" }
    sk      = { S = "APP_ORIGIN" }
    version = { N = "0" }
    origin  = { S = "https://${aws_cloudfront_distribution.web.domain_name}" }
  })
}
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "OnlyCloudFront", Effect = "Allow", Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.frontend.arn}/*", Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } } },
    { Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }
  ] })
}
