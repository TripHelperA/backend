# TripHelper Backend ☁️⚙️

This repository contains the serverless backend for the TripHelper application. The entire infrastructure is defined as code using the **AWS CDK** and is built to be scalable and efficient.

---

## 🏛️ Architecture Overview

Our backend is built on a serverless architecture using a suite of AWS services. The core of the application relies on **AWS Lambda** for compute logic and **AWS AppSync** to provide a flexible **GraphQL API** for our mobile client.

* **API Layer**: **AWS AppSync** serves as the GraphQL endpoint, allowing the frontend to fetch and mutate data efficiently, minimizing redundant data transfers compared to traditional REST APIs.
* **Compute Layer**: **AWS Lambda** functions (written in Node.js) handle all backend logic, from user authentication flows to the route-finding algorithm.
* **Route Finding Algorithm**: This is the core logic of our app. It uses the **Google Maps Platform** to find points of interest and then leverages **Amazon Bedrock** to run an LLM that ranks these places according to user preferences, creating a truly personalized route.
* **Data Storage**:
    * **Amazon DynamoDB**: A NoSQL database used to store user data, preferences, and saved routes.
    * **Amazon S3**: Used for storing user-uploaded images, such as profile pictures and route cover photos. We also use a Lambda function with the **Sharp** library to process these images.
* **Authentication**: **Amazon Cognito** handles all user authentication, including registration, login, and password recovery.
* **Monitoring**: **Amazon CloudWatch** is used to monitor Lambda usage and application logs.



---

## 🛠️ Tech Stack

* **Infrastructure as Code**: AWS CDK
* **Languages**: TypeScript & JavaScript
* **Runtime**: Node.js
* **Key AWS Services**:
    * AWS Lambda
    * AWS AppSync (GraphQL)
    * Amazon DynamoDB
    * Amazon S3
    * Amazon Cognito
    * Amazon Bedrock
    * Amazon CloudWatch

---

## 🚀 Deployment

To deploy the TripHelper backend infrastructure to your AWS account, follow the steps below.

### Prerequisites

* An AWS Account
* AWS CLI installed and configured with credentials
* Node.js (LTS version)
* AWS CDK Toolkit (`npm install -g aws-cdk`)

### Installation & Deployment

1.  **Clone the repository:**
    ```sh
    git clone [https://github.com/TripHelperA/backend.git](https://github.com/TripHelperA/backend.git)
    cd backend
    ```

2.  **Install dependencies:**
    ```sh
    npm install
    ```

3.  **Bootstrap your AWS environment (if you haven't used CDK in this region/account before):**
    ```sh
    cdk bootstrap
    ```

4.  **Deploy the CDK stack:**
    ```sh
    cdk deploy
    ```
    The CDK will provision all the necessary AWS resources defined in the stack.

---

## 👥 Contributors

* Ahmed Utku Özüdoğru
* Eren Özilgili
* İbrahim Enes Yılmaz
* Berkay Demirçin
* Ahmet Eren Gözübenli

**Mentor**: Apul Jain
