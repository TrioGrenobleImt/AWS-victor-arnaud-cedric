# --- Back-office sign-in: Cognito user pool (Lite tier, free up to 10k MAU) ----
# Back-office users must be in the "admins" group; there is no self sign-up.
# Members of "owners" (a second group) can also manage the team from the back
# office itself (admin API -> Cognito), so everyone else is just "staff". The SPA uses the Cognito hosted
# login page (authorization code + PKCE) and the admin API verifies the access
# tokens (signature, expiry, client id, group).
# backoffice_url (the back office's own CloudFront address) is defined in cdn.tf.

resource "aws_cognito_user_pool" "admin" {
  name                = "${var.project}-admin"
  user_pool_tier      = "LITE"
  username_attributes = ["email"]
  deletion_protection = "INACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "FISA Records back office access"
      email_message = "Your back-office username is {username} and your temporary password is {####}. Sign in at ${local.backoffice_url}"
      sms_message   = "Username {username}, temporary password {####}"
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "admin" {
  domain                = "${var.project}-admin-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.admin.id
  managed_login_version = 1 # classic hosted UI, available on the Lite tier
}

resource "aws_cognito_user_pool_client" "backoffice" {
  name         = "backoffice"
  user_pool_id = aws_cognito_user_pool.admin.id

  generate_secret                      = false # public SPA client, protected by PKCE
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [local.backoffice_url]
  logout_urls                          = [local.backoffice_url]

  # ADMIN_USER_PASSWORD_AUTH lets tests/test.sh get a token with IAM credentials.
  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.admin.id
  description  = "Back-office administrators"
}

resource "aws_cognito_user_group" "owners" {
  name         = "owners"
  user_pool_id = aws_cognito_user_pool.admin.id
  description  = "Back-office owners: also create, change and remove back-office accounts"
}

# First admin (an owner, so someone can invite the rest): Cognito emails a temporary password, changed at first sign-in.
resource "aws_cognito_user" "admin" {
  count                    = var.admin_email != "" ? 1 : 0
  user_pool_id             = aws_cognito_user_pool.admin.id
  username                 = var.admin_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.admin_email
    email_verified = true
  }
}

resource "aws_cognito_user_in_group" "admin" {
  count        = var.admin_email != "" ? 1 : 0
  user_pool_id = aws_cognito_user_pool.admin.id
  group_name   = aws_cognito_user_group.admins.name
  username     = aws_cognito_user.admin[0].username
}

resource "aws_cognito_user_in_group" "owner" {
  count        = var.admin_email != "" ? 1 : 0
  user_pool_id = aws_cognito_user_pool.admin.id
  group_name   = aws_cognito_user_group.owners.name
  username     = aws_cognito_user.admin[0].username
}

# --- Storefront sign-in: customers' own user pool ------------------------------
# Separate from the back-office pool so a customer account can never reach the
# admin API. Anyone can sign up (email + password, confirmed with a code Cognito
# emails); ordering still works without an account. The storefront uses the same
# hosted login + PKCE flow, and the shop API verifies the access tokens.
resource "aws_cognito_user_pool" "customers" {
  name                     = "${var.project}-customers"
  user_pool_tier           = "LITE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "INACTIVE"

  password_policy {
    minimum_length    = 10
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "customers" {
  domain                = "${var.project}-shop-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.customers.id
  managed_login_version = 1
}

resource "aws_cognito_user_pool_client" "storefront" {
  name         = "storefront"
  user_pool_id = aws_cognito_user_pool.customers.id

  generate_secret                      = false # public SPA client, protected by PKCE
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [local.storefront_url]
  logout_urls                          = [local.storefront_url]

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}
