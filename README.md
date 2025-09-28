Defines/deploys the backend infrastructure with pure cdk.

- To get the cloudformation file, run (not needed, you can deploy without synth):
  ```bash
  cdk synth
  ```
  at the project root.

- To deploy, first configure (only once) and then deploy:
  ```bash
  aws configure
  cdk deploy
  ```
  (only needed when updating infra code or after destroying) to deploy the infra to your aws account (care for costs)

- To take down the stack, run:
  ```bash
  cdk destroy
  ```
  on the project root.
