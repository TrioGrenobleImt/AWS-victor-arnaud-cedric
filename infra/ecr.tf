# --- Container registry + image build ----------------------------------------
# The API image (shop + admin entry points) is built locally (Docker) and pushed to ECR during apply.
# The tag is a hash of the backend sources, so any code change produces a new
# image, a new task definition revision and a rolling ECS deployment.
locals {
  backend_dir = "${path.module}/../backend"
  backend_files = sort(setunion(
    fileset(local.backend_dir, "{package.json,package-lock.json,Dockerfile}"),
    fileset(local.backend_dir, "api/**"),
    fileset(local.backend_dir, "admin/**"),
    fileset(local.backend_dir, "lib/**"),
  ))
  api_image_tag = substr(sha1(join("", [for f in local.backend_files : filesha1("${local.backend_dir}/${f}")])), 0, 12)
  api_image     = "${aws_ecr_repository.api.repository_url}:${local.api_image_tag}"
}

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}/shop-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true # basic scanning is free
  }
}

resource "terraform_data" "api_image" {
  triggers_replace = [local.api_image]

  provisioner "local-exec" {
    working_dir = local.backend_dir
    # One line chained with && so it runs the same under sh (Linux/macOS) and cmd.exe (Windows).
    command = "aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.api.repository_url)[0]} && docker buildx build --platform linux/amd64 --provenance=false -t ${local.api_image} --push ."
  }
}
