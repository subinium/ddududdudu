import { BackgroundExecutionService } from './background-execution-service.js';

export const runDetachedBackgroundJob = async (jobId: string): Promise<void> => {
  const service = new BackgroundExecutionService();
  await service.run(jobId);
};
