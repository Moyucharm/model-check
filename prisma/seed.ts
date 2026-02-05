import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Start seeding...");

  // Create a test channel
  const channel = await prisma.channel.upsert({
    where: { id: "test-channel-1" },
    update: {},
    create: {
      id: "test-channel-1",
      name: "Test OpenAI Channel",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test-key-placeholder",
      enabled: true,
    },
  });

  console.log(`Created channel: ${channel.name}`);

  // Create test models for the channel
  const models = [
    { modelName: "gpt-4", endpoints: ["CHAT"] },
    { modelName: "gpt-3.5-turbo", endpoints: ["CHAT"] },
    { modelName: "claude-3-opus", endpoints: ["CLAUDE"] },
    { modelName: "gemini-pro", endpoints: ["GEMINI"] },
  ];

  for (const model of models) {
    const created = await prisma.model.upsert({
      where: {
        channelId_modelName: {
          channelId: channel.id,
          modelName: model.modelName,
        },
      },
      update: {},
      create: {
        channelId: channel.id,
        modelName: model.modelName,
        detectedEndpoints: model.endpoints,
        lastStatus: null,
        lastLatency: null,
      },
    });
    console.log(`Created model: ${created.modelName}`);
  }

  console.log("Seeding finished.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
