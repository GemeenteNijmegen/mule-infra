import { Aspects, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';

interface MuleRuntimeStackProps extends StackProps, Configurable { }

export class MuleRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, private readonly props: MuleRuntimeStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    // cluster definieren
    // Task definition
    // service definieren
    // VPC regelen met security groups etc.
    // Image van ECR pullen
  }
}
