/**
 * Modular Automation Executor for Claude Flow
 * 
 * This module provides the core infrastructure for executing automation
 * workflows with Claude CLI integration, while preserving existing 
 * swarm and hive-mind functionality.
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { printSuccess, printError, printWarning } from '../utils.js';

// Simple ID generator
function generateId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * WorkflowExecutor - Core class for executing automation workflows
 */
export class WorkflowExecutor {
  constructor(options = {}) {
    this.options = {
      enableClaude: false,
      nonInteractive: false,
      outputFormat: 'text',
      maxConcurrency: 3,
      timeout: 3600000, // 1 hour default
      logLevel: 'info',
      ...options
    };
    
    // Increase timeout for ML workflows
    if (options.workflowType === 'ml' || options.workflowName?.toLowerCase().includes('mle')) {
      this.options.timeout = 7200000; // 2 hours for ML workflows
    }
    
    // Execution state
    this.executionId = generateId('workflow-exec');
    this.startTime = Date.now();
    this.activeTasks = new Map();
    this.claudeInstances = new Map();
    this.results = new Map();
    this.errors = [];
    
    // Hooks integration
    this.hooksEnabled = true;
    this.sessionId = generateId('automation-session');
  }

  /**
   * Execute a workflow from JSON definition
   */
  async executeWorkflow(workflowData, variables = {}) {
    try {
      console.log(`🚀 Starting workflow execution: ${this.executionId}`);
      console.log(`📋 Workflow: ${workflowData.name}`);
      console.log(`🎯 Strategy: MLE-STAR Machine Learning Engineering`);
      
      if (this.options.enableClaude) {
        console.log(`🤖 Claude CLI Integration: Enabled`);
      }
      
      if (this.options.nonInteractive) {
        console.log(`🖥️  Non-Interactive Mode: Enabled`);
        if (this.options.outputFormat === 'stream-json') {
          console.log();
          console.log('● Running MLE-STAR workflow with Claude CLI integration');
          console.log('  ⎿  Command format: claude --print --output-format stream-json --verbose --dangerously-skip-permissions');
          console.log('  ⎿  Each agent will show real-time stream output below');
          console.log('  ⎿  Interactive-style formatting enabled');
        }
      }
      
      console.log();

      // Pre-execution hooks
      if (this.hooksEnabled) {
        await this.executeHook('pre-task', {
          description: `Execute workflow: ${workflowData.name}`,
          sessionId: this.sessionId
        });
      }

      // Validate workflow
      this.validateWorkflow(workflowData);
      
      // Apply variable substitutions
      const processedWorkflow = this.applyVariables(workflowData, variables);
      
      // Initialize agents if Claude integration is enabled
      if (this.options.enableClaude) {
        await this.initializeClaudeAgents(processedWorkflow.agents);
      }
      
      // Execute workflow phases
      const result = await this.executeWorkflowTasks(processedWorkflow);
      
      // Post-execution hooks
      if (this.hooksEnabled) {
        await this.executeHook('post-task', {
          taskId: this.executionId,
          sessionId: this.sessionId,
          result: result.success ? 'success' : 'failure'
        });
      }
      
      const duration = Date.now() - this.startTime;
      
      if (result.success) {
        printSuccess(`✅ Workflow completed successfully in ${this.formatDuration(duration)}`);
        console.log(`📊 Tasks: ${result.completedTasks}/${result.totalTasks} completed`);
        console.log(`🆔 Execution ID: ${this.executionId}`);
      } else {
        printError(`❌ Workflow failed after ${this.formatDuration(duration)}`);
        console.log(`📊 Tasks: ${result.completedTasks}/${result.totalTasks} completed`);
        console.log(`❌ Errors: ${this.errors.length}`);
      }
      
      // Cleanup Claude instances
      if (this.options.enableClaude) {
        await this.cleanupClaudeInstances();
      }
      
      return result;
      
    } catch (error) {
      printError(`Workflow execution failed: ${error.message}`);
      await this.cleanupClaudeInstances();
      throw error;
    }
  }

  /**
   * Initialize Claude CLI instances for agents
   */
  async initializeClaudeAgents(agents) {
    if (!agents || agents.length === 0) {
      return;
    }

    console.log(`🤖 Initializing ${agents.length} Claude CLI instances...`);
    
    // In non-interactive mode, agents are spawned per task instead
    if (this.options.nonInteractive) {
      console.log(`📌 Note: In non-interactive mode, Claude instances are spawned per task`);
      console.log(`📋 Each task will launch its own Claude process with the specific prompt`);
      return;
    }
    
    for (const agent of agents) {
      try {
        // Check if Claude CLI is available
        if (!await this.isClaudeAvailable()) {
          throw new Error('Claude CLI not found. Please install Claude Code: https://claude.ai/code');
        }
        
        // Create agent-specific prompt
        const agentPrompt = this.createAgentPrompt(agent);
        
        // Spawn Claude instance for this agent
        const claudeProcess = await this.spawnClaudeInstance(agent, agentPrompt);
        
        this.claudeInstances.set(agent.id, {
          process: claudeProcess,
          agent: agent,
          status: 'active',
          startTime: Date.now()
        });
        
        console.log(`  ✅ ${agent.name} (${agent.type}) - PID: ${claudeProcess.pid}`);
        
      } catch (error) {
        console.error(`  ❌ Failed to initialize ${agent.name}: ${error.message}`);
        this.errors.push({
          type: 'agent_initialization',
          agent: agent.id,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    if (this.claudeInstances.size > 0) {
      console.log(`✅ ${this.claudeInstances.size} Claude instances active`);
    }
    console.log();
  }

  /**
   * Check if Claude CLI is available
   */
  async isClaudeAvailable() {
    try {
      const { execSync } = await import('child_process');
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a Claude CLI instance for an agent
   */
  async spawnClaudeInstance(agent, prompt) {
    const claudeArgs = [];
    
    // Add flags based on mode
    if (this.options.nonInteractive) {
      // Non-interactive mode: use --print with stream-json output
      claudeArgs.push('--print');
      if (this.options.outputFormat === 'stream-json') {
        claudeArgs.push('--output-format', 'stream-json');
        claudeArgs.push('--verbose'); // Required for stream-json
      }
      // Skip permissions for automated workflows
      claudeArgs.push('--dangerously-skip-permissions');
    }
    
    // Always add the prompt as the final argument
    claudeArgs.push(prompt);
    
    // Log the command being executed (truncate long prompts)
    const displayPrompt = prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;
    const flagsDisplay = this.options.nonInteractive ? 
      (this.options.outputFormat === 'stream-json' ? '--print --output-format stream-json --verbose --dangerously-skip-permissions' : '--print --dangerously-skip-permissions') : '';
    console.log(`    🤖 Spawning Claude for ${agent.name}: claude ${flagsDisplay} "${displayPrompt}"`);
    
    // Determine stdio configuration based on mode
    const stdioConfig = this.options.nonInteractive ? 
      ['inherit', 'pipe', 'pipe'] : // Non-interactive: pipe output for processing
      ['inherit', 'inherit', 'inherit']; // Interactive: inherit all for normal Claude interaction
    
    // Spawn Claude process
    const claudeProcess = spawn('claude', claudeArgs, {
      stdio: stdioConfig,
      shell: false,
    });
    
    // Handle stdout with stream processor for better formatting (only in non-interactive mode)
    if (this.options.nonInteractive && this.options.outputFormat === 'stream-json' && claudeProcess.stdout) {
      // Import and use stream processor
      const { createStreamProcessor } = await import('./stream-processor.js');
      const streamProcessor = createStreamProcessor(
        agent.name,
        this.getAgentIcon(agent.id),
        {
          verbose: this.options.logLevel === 'debug',
          taskId: agent.taskId,
          agentId: agent.id,
          display: this.concurrentDisplay
        }
      );
      
      // Pipe stdout through processor
      claudeProcess.stdout.pipe(streamProcessor);
      
      // Handle stderr for non-interactive mode
      claudeProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          console.error(`    ❌ [${agent.name}] Error: ${message}`);
        }
      });
    } else if (this.options.nonInteractive && this.options.outputFormat !== 'stream-json') {
      // For non-interactive non-stream-json output, show stdout directly
      claudeProcess.stdout.on('data', (data) => {
        console.log(data.toString().trimEnd());
      });
      
      claudeProcess.stderr.on('data', (data) => {
        console.error(data.toString().trimEnd());
      });
    }
    // Note: In interactive mode, stdio is inherited so Claude handles its own I/O
    
    // Handle process events
    claudeProcess.on('error', (error) => {
      console.error(`❌ Claude instance error for ${agent.name}:`, error.message);
      this.errors.push({
        type: 'claude_instance_error',
        agent: agent.id,
        error: error.message,
        timestamp: new Date()
      });
    });
    
    claudeProcess.on('exit', (code) => {
      const instance = this.claudeInstances.get(agent.id);
      if (instance) {
        instance.status = code === 0 ? 'completed' : 'failed';
        instance.exitCode = code;
        instance.endTime = Date.now();
      }
    });
    
    return claudeProcess;
  }

  /**
   * Handle Claude stream events
   */
  handleClaudeStreamEvent(agent, event) {
    if (this.options.outputFormat === 'stream-json') {
      // Create concise formatted JSON with summary
      const summary = this.getEventSummary(event);
      const icon = this.getEventIcon(event.type);
      
      // Simplified output for better readability
      const output = {
        t: new Date().toISOString().split('T')[1].split('.')[0], // HH:MM:SS
        agent: `${this.getAgentIcon(agent.id)} ${agent.name}`,
        phase: this.currentPhase,
        event: `${icon} ${summary}`
      };
      
      // Add relevant details based on event type
      if (event.type === 'tool_use' && event.name) {
        output.tool = event.name;
      } else if (event.type === 'error' && event.error) {
        output.error = event.error;
      }
      
      console.log(JSON.stringify(output));
    } else {
      // Format output for text mode
      switch (event.type) {
        case 'tool_use':
          console.log(`    [${agent.name}] 🔧 Using tool: ${event.name}`);
          break;
        case 'message':
          console.log(`    [${agent.name}] 💬 ${event.content}`);
          break;
        case 'completion':
          console.log(`    [${agent.name}] ✅ Task completed`);
          break;
        case 'error':
          console.error(`    [${agent.name}] ❌ Error: ${event.error}`);
          break;
        default:
          // Log other events in debug mode
          if (this.options.logLevel === 'debug') {
            console.log(`    [${agent.name}] ${event.type}: ${JSON.stringify(event)}`);
          }
      }
    }
  }
  
  /**
   * Get a brief summary of an event
   */
  getEventSummary(event) {
    switch (event.type) {
      case 'tool_use':
        return `Using ${event.name} tool`;
      case 'message':
        return event.content?.substring(0, 100) + (event.content?.length > 100 ? '...' : '');
      case 'completion':
        return 'Task completed successfully';
      case 'error':
        return `Error: ${event.error}`;
      case 'status':
        return event.status || 'Status update';
      default:
        return event.type;
    }
  }
  
  /**
   * Get icon for event type
   */
  getEventIcon(eventType) {
    const icons = {
      'tool_use': '🔧',
      'message': '💬',
      'completion': '✅',
      'error': '❌',
      'status': '📊',
      'init': '🚀',
      'thinking': '🤔',
      'result': '📋'
    };
    return icons[eventType] || '📌';
  }

  /**
   * Create task-specific Claude prompt
   */
  createTaskPrompt(task, agent, workflow) {
    // Use the claudePrompt from the task if available
    if (task.claudePrompt) {
      // Apply variable substitutions to the prompt
      let prompt = task.claudePrompt;
      const allVariables = { ...workflow.variables, ...task.input };
      
      for (const [key, value] of Object.entries(allVariables)) {
        const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
        prompt = prompt.replace(pattern, value);
      }
      
      // Add coordination instructions
      return `${prompt}

COORDINATION REQUIREMENTS:
- Session ID: ${this.sessionId}
- Task ID: ${task.id}
- Use hooks for coordination: npx claude-flow@alpha hooks [command]
- Store results in memory: npx claude-flow@alpha memory store
- This is an automated workflow execution - complete the task and exit when done`;
    } else {
      // Fallback to agent prompt
      return this.createAgentPrompt(agent);
    }
  }

  /**
   * Create agent-specific Claude prompt
   */
  createAgentPrompt(agent) {
    const { config } = agent;
    const capabilities = config?.capabilities?.join(', ') || 'general automation';
    
    return `You are the ${agent.name} in a coordinated MLE-STAR automation workflow.

🎯 AGENT ROLE: ${agent.type.toUpperCase()}
📋 CAPABILITIES: ${capabilities}
🆔 AGENT ID: ${agent.id}

CRITICAL COORDINATION REQUIREMENTS:
1. HOOKS: Use claude-flow hooks for coordination:
   - Run "npx claude-flow@alpha hooks pre-task --description '[your task]'" before starting
   - Run "npx claude-flow@alpha hooks post-edit --file '[file]'" after each file operation  
   - Run "npx claude-flow@alpha hooks post-task --task-id '${agent.id}'" when complete

2. MEMORY: Store all findings and results:
   - Use "npx claude-flow@alpha memory store 'agent/${agent.id}/[key]' '[value]'" for important data
   - Check "npx claude-flow@alpha memory search 'agent/*'" for coordination with other agents

3. SESSION: Maintain session coordination:
   - Session ID: ${this.sessionId}
   - Execution ID: ${this.executionId}

AGENT-SPECIFIC CONFIGURATION:
${JSON.stringify(config, null, 2)}

MLE-STAR METHODOLOGY FOCUS:
${this.getMethodologyGuidance(agent.type)}

WORKFLOW COORDINATION:
- Work with other agents in the pipeline: Search → Foundation → Refinement → Ensemble → Validation
- Share findings through memory system
- Use proper file naming conventions: ${agent.id}_[component].[ext]
- Follow MLE-STAR best practices for your role

Execute your role in the MLE-STAR workflow with full coordination and hook integration.`;
  }

  /**
   * Get methodology guidance for agent type
   */
  getMethodologyGuidance(agentType) {
    const guidance = {
      researcher: `SEARCH PHASE - Web Research & Foundation Discovery:
- Search for state-of-the-art ML approaches for the problem domain
- Find winning Kaggle solutions and benchmark results
- Identify promising model architectures and techniques
- Document implementation examples and model cards
- Focus on proven, recent approaches with good performance`,

      coder: `FOUNDATION PHASE - Initial Model Building:
- Analyze dataset characteristics and problem type
- Implement baseline models based on research findings
- Create robust preprocessing pipelines
- Build modular, testable code components
- Establish performance baselines for comparison`,

      optimizer: `REFINEMENT PHASE - Targeted Component Optimization:
- Perform ablation analysis to identify high-impact components
- Focus deep optimization on most impactful pipeline elements
- Use iterative improvement with structured feedback
- Implement advanced feature engineering techniques
- Optimize hyperparameters systematically`,

      architect: `ENSEMBLE PHASE - Intelligent Model Combination:
- Create sophisticated ensemble strategies beyond simple averaging
- Implement stacking with meta-learners
- Use dynamic weighting and mixture of experts
- Apply Bayesian model averaging where appropriate
- Optimize ensemble composition for maximum performance`,

      tester: `VALIDATION PHASE - Comprehensive Testing & Debugging:
- Implement rigorous cross-validation strategies
- Detect and prevent data leakage
- Perform error analysis and debugging
- Validate model robustness and generalization
- Ensure production readiness with quality checks`,

      coordinator: `ORCHESTRATION PHASE - Workflow Management:
- Coordinate between all agents and phases
- Monitor progress and performance metrics
- Manage resource allocation and scheduling
- Handle error recovery and workflow adaptation
- Prepare final deployment and documentation`
    };

    return guidance[agentType] || 'Focus on your specialized capabilities and coordinate with other agents.';
  }

  /**
   * Execute workflow tasks with dependency management
   */
  async executeWorkflowTasks(workflow) {
    const { tasks, dependencies = {} } = workflow;
    
    let completedTasks = 0;
    let failedTasks = 0;
    const totalTasks = tasks.length;
    
    // Task status tracking
    const taskStatuses = new Map();
    tasks.forEach(task => {
      taskStatuses.set(task.id, {
        name: task.name || task.id,
        status: 'pending',
        agent: task.assignTo,
        startTime: null,
        endTime: null,
        summary: ''
      });
    });
    
    // Create task execution plan based on dependencies
    const executionPlan = this.createExecutionPlan(tasks, dependencies);
    
    console.log(`📋 Executing ${totalTasks} tasks in ${executionPlan.length} phases...`);
    console.log();
    
    // Note: Concurrent display disabled in favor of interactive-style stream processing
    let concurrentDisplay = null;
    // if (this.options.nonInteractive && this.options.outputFormat === 'stream-json') {
    //   const { createConcurrentDisplay } = await import('./concurrent-display.js');
    //   
    //   // Get all agents and their tasks
    //   const agentTasks = workflow.agents?.map(agent => ({
    //     id: agent.id,
    //     name: agent.name,
    //     type: agent.type,
    //     tasks: tasks.filter(t => t.assignTo === agent.id).map(t => t.name)
    //   })) || [];
    //   
    //   concurrentDisplay = createConcurrentDisplay(agentTasks);
    //   concurrentDisplay.start();
    //   
    //   // Store reference for stream processors
    //   this.concurrentDisplay = concurrentDisplay;
    // }
    
    // Execute tasks phase by phase
    for (const [phaseIndex, phaseTasks] of executionPlan.entries()) {
      this.currentPhase = `Phase ${phaseIndex + 1}`;
      
      // Show regular task board or update concurrent display
      if (!concurrentDisplay) {
        console.log(`\n🔄 Phase ${phaseIndex + 1}: ${phaseTasks.length} concurrent tasks`);
        this.displayTaskBoard(taskStatuses, phaseTasks);
      }
      
      // Mark tasks as in-progress
      phaseTasks.forEach(task => {
        const status = taskStatuses.get(task.id);
        status.status = 'in-progress';
        status.startTime = Date.now();
      });
      
      // Execute tasks in this phase (potentially in parallel)
      const phasePromises = phaseTasks.map(async (task) => {
        const taskStatus = taskStatuses.get(task.id);
        
        try {
          // Show task starting
          console.log(`\n  🚀 Starting: ${task.name || task.id}`);
          console.log(`     Agent: ${task.assignTo}`);
          console.log(`     Description: ${task.description?.substring(0, 80)}...`);
          
          const result = await this.executeTask(task, workflow);
          
          taskStatus.status = result.success ? 'completed' : 'failed';
          taskStatus.endTime = Date.now();
          taskStatus.summary = result.success ? 
            `✅ Completed in ${this.formatDuration(result.duration)}` :
            `❌ Failed: ${result.error?.message || 'Unknown error'}`;
          
          return result;
        } catch (error) {
          taskStatus.status = 'failed';
          taskStatus.endTime = Date.now();
          taskStatus.summary = `❌ Error: ${error.message}`;
          throw error;
        }
      });
      
      // Wait for all phase tasks to complete
      const phaseResults = await Promise.allSettled(phasePromises);
      
      // Process phase results
      for (const [taskIndex, result] of phaseResults.entries()) {
        const task = phaseTasks[taskIndex];
        const taskStatus = taskStatuses.get(task.id);
        
        if (result.status === 'fulfilled' && result.value.success) {
          completedTasks++;
          this.results.set(task.id, result.value);
        } else {
          failedTasks++;
          const error = result.status === 'rejected' ? result.reason : result.value.error;
          this.errors.push({
            type: 'task_execution',
            task: task.id,
            error: error.message || error,
            timestamp: new Date()
          });
          
          // Check if we should fail fast
          if (workflow.settings?.failurePolicy === 'fail-fast') {
            console.log(`\n🛑 Failing fast due to task failure`);
            break;
          }
        }
      }
      
      // Show updated task board
      if (!concurrentDisplay) {
        console.log(`\n📊 Phase ${phaseIndex + 1} Complete:`);
        this.displayTaskBoard(taskStatuses);
      }
      
      // Stop if fail-fast and we have failures
      if (workflow.settings?.failurePolicy === 'fail-fast' && failedTasks > 0) {
        break;
      }
    }
    
    // Final summary
    if (!concurrentDisplay) {
      console.log(`\n📊 Final Workflow Summary:`);
      this.displayTaskBoard(taskStatuses);
    } else {
      // Stop concurrent display
      concurrentDisplay.stop();
      console.log(); // Add some space after display
    }
    
    return {
      success: failedTasks === 0,
      totalTasks,
      completedTasks,
      failedTasks,
      executionId: this.executionId,
      duration: Date.now() - this.startTime,
      results: Object.fromEntries(this.results),
      errors: this.errors
    };
  }
  
  /**
   * Display task board showing current status
   */
  displayTaskBoard(taskStatuses, highlightTasks = []) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const frameIndex = Math.floor(Date.now() / 100) % frames.length;
    const spinner = frames[frameIndex];
    
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    🤖 CONCURRENT TASK STATUS                   ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    
    // Group by status
    const statusGroups = {
      'in-progress': [],
      'completed': [],
      'failed': [],
      'pending': []
    };
    
    taskStatuses.forEach((status, taskId) => {
      statusGroups[status.status].push({ taskId, ...status });
    });
    
    // Show in-progress tasks with animation
    if (statusGroups['in-progress'].length > 0) {
      console.log(`║ ${spinner} RUNNING (${statusGroups['in-progress'].length} agents):                                      ║`);
      statusGroups['in-progress'].forEach(task => {
        const duration = task.startTime ? this.formatDuration(Date.now() - task.startTime) : '';
        const progress = this.getProgressBar(Date.now() - task.startTime, 60000); // 1 min expected
        const agentIcon = this.getAgentIcon(task.agent);
        console.log(`║   ${agentIcon} ${task.name.padEnd(25)} ${progress} ${duration.padStart(8)} ║`);
      });
    }
    
    // Show completed tasks
    if (statusGroups['completed'].length > 0) {
      console.log(`║ ✅ COMPLETED (${statusGroups['completed'].length}):                                           ║`);
      statusGroups['completed'].forEach(task => {
        const duration = task.endTime && task.startTime ? 
          this.formatDuration(task.endTime - task.startTime) : '';
        console.log(`║   ✓ ${task.name.padEnd(35)} ${duration.padStart(10)} ║`);
      });
    }
    
    // Show failed tasks
    if (statusGroups['failed'].length > 0) {
      console.log(`║ ❌ FAILED (${statusGroups['failed'].length}):                                              ║`);
      statusGroups['failed'].forEach(task => {
        const errorMsg = (task.summary || '').substring(0, 25);
        console.log(`║   ✗ ${task.name.padEnd(25)} ${errorMsg.padEnd(20)} ║`);
      });
    }
    
    // Show pending tasks count
    if (statusGroups['pending'].length > 0) {
      console.log(`║ ⏳ QUEUED: ${statusGroups['pending'].length} tasks waiting                                 ║`);
    }
    
    // Summary stats
    const total = taskStatuses.size;
    const completed = statusGroups['completed'].length;
    const failed = statusGroups['failed'].length;
    const progress = total > 0 ? Math.floor((completed + failed) / total * 100) : 0;
    
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║ 📊 Progress: ${progress}% (${completed}/${total}) │ ⚡ Active: ${statusGroups['in-progress'].length} │ ❌ Failed: ${failed}  ║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');
  }
  
  /**
   * Get progress bar visualization
   */
  getProgressBar(elapsed, expected) {
    const progress = Math.min(elapsed / expected, 1);
    const filled = Math.floor(progress * 10);
    const empty = 10 - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }
  
  /**
   * Get agent icon based on type
   */
  getAgentIcon(agentId) {
    const icons = {
      'search': '🔍',
      'foundation': '🏗️',
      'refinement': '🔧',
      'ensemble': '🎯',
      'validation': '✅',
      'coordinator': '🎮',
      'researcher': '🔬',
      'coder': '💻',
      'optimizer': '⚡',
      'architect': '🏛️',
      'tester': '🧪'
    };
    
    // Extract agent type from ID
    const type = agentId?.split('_')[0] || 'default';
    return icons[type] || '🤖';
  }

  /**
   * Execute a single task
   */
  async executeTask(task, workflow) {
    const startTime = Date.now();
    
    try {
      // Store task execution in memory if hooks enabled
      if (this.hooksEnabled) {
        await this.executeHook('notify', {
          message: `Starting task: ${task.name || task.id}`,
          sessionId: this.sessionId
        });
      }
      
      if (this.options.nonInteractive && this.options.outputFormat === 'stream-json') {
        console.log(`\n● ${task.name || task.id} - Starting Execution`);
        console.log(`  ⎿  ${task.description}`);
        console.log(`  ⎿  Agent: ${task.assignTo}`);
      } else {
        console.log(`    🔄 Executing: ${task.description}`);
      }
      
      // For demonstration/testing mode (when Claude integration is disabled)
      // we simulate successful task completion
      if (!this.options.enableClaude) {
        // Simulate variable execution time
        const executionTime = Math.min(
          1000 + Math.random() * 3000, // 1-4 seconds simulation
          task.timeout || 30000
        );
        
        await new Promise(resolve => setTimeout(resolve, executionTime));
        
        // Simulate successful completion for demo/testing
        const result = {
          success: true,
          taskId: task.id,
          duration: Date.now() - startTime,
          output: {
            status: 'completed',
            agent: task.assignTo,
            executionTime: Date.now() - startTime,
            metadata: {
              timestamp: new Date().toISOString(),
              executionId: this.executionId,
              mode: 'simulation'
            }
          }
        };
        
        // Store result in memory
        if (this.hooksEnabled) {
          await this.storeTaskResult(task.id, result.output);
        }
        
        return result;
      } else {
        // When Claude integration is enabled, delegate to actual Claude instance
        const claudeInstance = this.claudeInstances.get(task.assignTo);
        if (!claudeInstance) {
          // If no pre-spawned instance, create one for this task
          const agent = workflow.agents.find(a => a.id === task.assignTo);
          if (!agent) {
            throw new Error(`No agent definition found for: ${task.assignTo}`);
          }
          
          // Create task-specific prompt
          const taskPrompt = this.createTaskPrompt(task, agent, workflow);
          
          // Spawn Claude instance for this specific task
          const taskClaudeProcess = await this.spawnClaudeInstance(agent, taskPrompt);
          
          // Store the instance
          this.claudeInstances.set(agent.id, {
            process: taskClaudeProcess,
            agent: agent,
            status: 'active',
            startTime: Date.now(),
            taskId: task.id
          });
          
          // Wait for task completion or timeout
          // Use longer timeout for ML tasks
          const baseTimeout = this.options.timeout || 60000;
          const isMLTask = task.type?.toLowerCase().includes('ml') || 
                          task.type?.toLowerCase().includes('model') ||
                          task.type?.toLowerCase().includes('search') ||
                          task.type?.toLowerCase().includes('analysis') ||
                          this.options.workflowType === 'ml';
          const timeout = task.timeout || (isMLTask ? Math.max(baseTimeout, 300000) : baseTimeout); // Min 5 minutes for ML tasks
          
          if (this.options.logLevel === 'debug' || this.options.verbose) {
            console.log(`    ⏱️  Timeout: ${this.formatDuration(timeout)} (Base: ${this.formatDuration(baseTimeout)}, ML Task: ${isMLTask})`);
          }
          
          const completionPromise = new Promise((resolve, reject) => {
            taskClaudeProcess.on('exit', (code) => {
              if (code === 0) {
                resolve({ success: true, code });
              } else {
                reject(new Error(`Process exited with code ${code}`));
              }
            });
            
            taskClaudeProcess.on('error', (err) => {
              reject(err);
            });
          });
          
          const timeoutPromise = new Promise((_, reject) => {
            // Use a much longer timeout for ML tasks since Claude is actively working
            const actualTimeout = isMLTask ? Math.max(timeout, 600000) : timeout; // 10 min minimum for ML
            setTimeout(() => reject(new Error('Task timeout')), actualTimeout);
          });
          
          try {
            await Promise.race([completionPromise, timeoutPromise]);
            
            const result = {
              success: true,
              taskId: task.id,
              duration: Date.now() - startTime,
              output: {
                status: 'completed',
                agent: task.assignTo,
                executionTime: Date.now() - startTime,
                metadata: {
                  timestamp: new Date().toISOString(),
                  executionId: this.executionId,
                  mode: 'claude-task-execution'
                }
              }
            };
            
            // Store result in memory
            if (this.hooksEnabled) {
              await this.storeTaskResult(task.id, result.output);
            }
            
            return result;
          } catch (error) {
            throw error;
          }
        } else {
          // Use existing Claude instance
          // In a full implementation, this would send the task to the running instance
          // For now, we'll spawn a new instance per task for simplicity
          
          const agent = claudeInstance.agent;
          const taskPrompt = this.createTaskPrompt(task, agent, workflow);
          
          // For now, spawn a new instance for each task
          const taskClaudeProcess = await this.spawnClaudeInstance(agent, taskPrompt);
          
          // Wait for completion
          // Use longer timeout for ML tasks
          const baseTimeout = this.options.timeout || 60000;
          const isMLTask = task.type?.toLowerCase().includes('ml') || 
                          task.type?.toLowerCase().includes('model') ||
                          task.type?.toLowerCase().includes('search') ||
                          task.type?.toLowerCase().includes('analysis') ||
                          this.options.workflowType === 'ml';
          const timeout = task.timeout || (isMLTask ? Math.max(baseTimeout, 300000) : baseTimeout); // Min 5 minutes for ML tasks
          
          if (this.options.logLevel === 'debug' || this.options.verbose) {
            console.log(`    ⏱️  Timeout: ${this.formatDuration(timeout)} (Base: ${this.formatDuration(baseTimeout)}, ML Task: ${isMLTask})`);
          }
          
          const completionPromise = new Promise((resolve, reject) => {
            taskClaudeProcess.on('exit', (code) => {
              if (code === 0) {
                resolve({ success: true, code });
              } else {
                reject(new Error(`Process exited with code ${code}`));
              }
            });
            
            taskClaudeProcess.on('error', (err) => {
              reject(err);
            });
          });
          
          const timeoutPromise = new Promise((_, reject) => {
            // Use a much longer timeout for ML tasks since Claude is actively working
            const actualTimeout = isMLTask ? Math.max(timeout, 600000) : timeout; // 10 min minimum for ML
            setTimeout(() => reject(new Error('Task timeout')), actualTimeout);
          });
          
          try {
            await Promise.race([completionPromise, timeoutPromise]);
            
            const result = {
              success: true,
              taskId: task.id,
              duration: Date.now() - startTime,
              output: {
                status: 'completed',
                agent: task.assignTo,
                executionTime: Date.now() - startTime,
                metadata: {
                  timestamp: new Date().toISOString(),
                  executionId: this.executionId,
                  mode: 'claude-task-execution'
                }
              }
            };
            
            // Store result in memory
            if (this.hooksEnabled) {
              await this.storeTaskResult(task.id, result.output);
            }
            
            return result;
          } catch (error) {
            throw error;
          }
        }
      }
      
    } catch (error) {
      return {
        success: false,
        taskId: task.id,
        duration: Date.now() - startTime,
        error: error
      };
    }
  }

  /**
   * Create execution plan based on task dependencies
   */
  createExecutionPlan(tasks, dependencies) {
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const completed = new Set();
    const phases = [];
    
    while (completed.size < tasks.length) {
      const readyTasks = tasks.filter(task => {
        if (completed.has(task.id)) return false;
        
        const deps = task.depends || dependencies[task.id] || [];
        return deps.every(dep => completed.has(dep));
      });
      
      if (readyTasks.length === 0) {
        throw new Error('Circular dependency detected or invalid dependencies');
      }
      
      phases.push(readyTasks);
      readyTasks.forEach(task => completed.add(task.id));
    }
    
    return phases;
  }

  /**
   * Execute a hook command
   */
  async executeHook(hookType, params) {
    try {
      const { execSync } = await import('child_process');
      
      let hookCommand = `npx claude-flow@alpha hooks ${hookType}`;
      
      if (params.description) {
        hookCommand += ` --description "${params.description}"`;
      }
      if (params.file) {
        hookCommand += ` --file "${params.file}"`;
      }
      if (params.taskId) {
        hookCommand += ` --task-id "${params.taskId}"`;
      }
      if (params.sessionId) {
        hookCommand += ` --session-id "${params.sessionId}"`;
      }
      if (params.message) {
        hookCommand += ` --message "${params.message}"`;
      }
      
      execSync(hookCommand, { stdio: 'pipe' });
      
    } catch (error) {
      // Hooks are optional, don't fail the workflow if they fail
      console.debug(`Hook ${hookType} failed:`, error.message);
    }
  }

  /**
   * Store task result in memory
   */
  async storeTaskResult(taskId, result) {
    try {
      const { execSync } = await import('child_process');
      const resultJson = JSON.stringify(result);
      
      execSync(`npx claude-flow@alpha memory store "workflow/${this.executionId}/${taskId}" '${resultJson}'`, {
        stdio: 'pipe'
      });
      
    } catch (error) {
      console.debug(`Failed to store task result for ${taskId}:`, error.message);
    }
  }

  /**
   * Validate workflow definition
   */
  validateWorkflow(workflow) {
    if (!workflow.name) {
      throw new Error('Workflow name is required');
    }
    
    if (!workflow.tasks || workflow.tasks.length === 0) {
      throw new Error('Workflow must contain at least one task');
    }
    
    // Validate task structure
    for (const task of workflow.tasks) {
      if (!task.id || !task.type || !task.description) {
        throw new Error(`Task ${task.id || 'unknown'} is missing required fields`);
      }
    }
    
    // Validate agent assignments
    if (workflow.agents) {
      const agentIds = new Set(workflow.agents.map(a => a.id));
      for (const task of workflow.tasks) {
        if (task.assignTo && !agentIds.has(task.assignTo)) {
          throw new Error(`Task ${task.id} assigned to unknown agent: ${task.assignTo}`);
        }
      }
    }
  }

  /**
   * Apply variable substitutions to workflow
   */
  applyVariables(workflow, variables) {
    const allVariables = { ...workflow.variables, ...variables };
    const workflowStr = JSON.stringify(workflow);
    
    // Simple variable substitution
    let processedStr = workflowStr;
    for (const [key, value] of Object.entries(allVariables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      processedStr = processedStr.replace(pattern, value);
    }
    
    return JSON.parse(processedStr);
  }

  /**
   * Cleanup Claude instances
   */
  async cleanupClaudeInstances() {
    if (this.claudeInstances.size === 0) return;
    
    console.log('🧹 Cleaning up Claude instances...');
    
    for (const [agentId, instance] of this.claudeInstances.entries()) {
      try {
        if (instance.process && !instance.process.killed) {
          instance.process.kill('SIGTERM');
          
          // Wait for graceful shutdown, then force kill if needed
          setTimeout(() => {
            if (!instance.process.killed) {
              instance.process.kill('SIGKILL');
            }
          }, 5000);
        }
        
        console.log(`  ✅ Cleaned up ${instance.agent.name}`);
        
      } catch (error) {
        console.error(`  ❌ Error cleaning up ${instance.agent.name}:`, error.message);
      }
    }
    
    this.claudeInstances.clear();
  }

  /**
   * Format duration in human readable format
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Load workflow from file
 */
export async function loadWorkflowFromFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    if (filePath.endsWith('.json')) {
      return JSON.parse(content);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      // For now, just return error - YAML support can be added later
      throw new Error('YAML workflows not yet supported');
    } else {
      throw new Error('Unsupported workflow file format. Use .json or .yaml');
    }
    
  } catch (error) {
    throw new Error(`Failed to load workflow: ${error.message}`);
  }
}

/**
 * Get default MLE-STAR workflow path
 */
export function getMLEStarWorkflowPath() {
  return join(process.cwd(), 'src', 'cli', 'simple-commands', 'templates', 'mle-star-workflow.json');
}