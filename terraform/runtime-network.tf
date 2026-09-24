locals { runtime_count = var.provision_runtime ? 1 : 0 }
data "aws_ami" "runtime" {
  count  = local.runtime_count
  owners = [var.runtime_ami_owner]
  filter {
    name   = "image-id"
    values = [var.runtime_ami_id]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}
resource "aws_vpc" "runtime" {
  count                = local.runtime_count
  cidr_block           = var.runtime_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
}
resource "aws_subnet" "runtime_public" {
  count                   = local.runtime_count
  vpc_id                  = aws_vpc.runtime[0].id
  cidr_block              = cidrsubnet(var.runtime_vpc_cidr, 8, 0)
  availability_zone       = var.runtime_availability_zone
  map_public_ip_on_launch = false
}
resource "aws_subnet" "runtime_private" {
  count                   = local.runtime_count
  vpc_id                  = aws_vpc.runtime[0].id
  cidr_block              = cidrsubnet(var.runtime_vpc_cidr, 8, 1)
  availability_zone       = var.runtime_availability_zone
  map_public_ip_on_launch = false
}
resource "aws_internet_gateway" "runtime" {
  count  = local.runtime_count
  vpc_id = aws_vpc.runtime[0].id
}
resource "aws_eip" "runtime_nat" {
  count  = local.runtime_count
  domain = "vpc"
}
resource "aws_nat_gateway" "runtime" {
  count         = local.runtime_count
  allocation_id = aws_eip.runtime_nat[0].id
  subnet_id     = aws_subnet.runtime_public[0].id
  depends_on    = [aws_internet_gateway.runtime]
}
resource "aws_route_table" "runtime_public" {
  count  = local.runtime_count
  vpc_id = aws_vpc.runtime[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runtime[0].id
  }
}
resource "aws_route_table" "runtime_private" {
  count  = local.runtime_count
  vpc_id = aws_vpc.runtime[0].id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.runtime[0].id
  }
}
resource "aws_route_table_association" "runtime_public" {
  count          = local.runtime_count
  subnet_id      = aws_subnet.runtime_public[0].id
  route_table_id = aws_route_table.runtime_public[0].id
}
resource "aws_route_table_association" "runtime_private" {
  count          = local.runtime_count
  subnet_id      = aws_subnet.runtime_private[0].id
  route_table_id = aws_route_table.runtime_private[0].id
}
resource "aws_security_group" "runtime" {
  count       = local.runtime_count
  name        = "${var.name}-runtime"
  description = "No inbound access; outbound HTTPS for AWS, image registry and Runpod"
  vpc_id      = aws_vpc.runtime[0].id
  ingress     = []
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
