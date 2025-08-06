"""Main CLI interface for the swarm benchmark tool."""

import click
import asyncio
import json
from pathlib import Path
from typing import Optional

from swarm_benchmark import __version__
from swarm_benchmark.core.models import StrategyType, CoordinationMode, BenchmarkConfig
from swarm_benchmark.core.benchmark_engine import BenchmarkEngine
from swarm_benchmark.core.real_benchmark_engine import RealBenchmarkEngine


@click.group()
@click.version_option(version=__version__)
@click.option('--verbose', '-v', is_flag=True, help='Enable verbose output')
@click.option('--config', '-c', type=click.Path(exists=True), help='Configuration file path')
@click.option('--real/--mock', default=False, help='Use real claude-flow execution')
@click.option('--claude-flow-path', default='./claude-flow', help='Path to claude-flow')
@click.option('--timeout', default=300, help='Command timeout in seconds')
@click.option('--stream/--no-stream', default=True, help='Stream output')
@click.pass_context
def cli(ctx, verbose, config, real, claude_flow_path, timeout, stream):
    """Claude Flow Advanced Swarm Benchmarking Tool.
    
    A comprehensive Python-based benchmarking tool for agent swarms that interfaces 
    with the Claude Flow Advanced Swarm System.
    """
    ctx.ensure_object(dict)
    ctx.obj['verbose'] = verbose
    ctx.obj['config'] = config
    ctx.obj['real'] = real
    ctx.obj['claude_flow_path'] = claude_flow_path
    ctx.obj['timeout'] = timeout
    ctx.obj['stream'] = stream


@cli.command()
@click.argument('objective')
@click.option('--strategy', 
              type=click.Choice(['auto', 'research', 'development', 'analysis', 'testing', 'optimization', 'maintenance']),
              default='auto',
              help='Execution strategy (default: auto)')
@click.option('--mode',
              type=click.Choice(['centralized', 'distributed', 'hierarchical', 'mesh', 'hybrid']),
              default='centralized', 
              help='Coordination mode (default: centralized)')
@click.option('--max-agents', type=int, default=5, help='Maximum agents (default: 5)')
@click.option('--max-tasks', type=int, default=100, help='Maximum tasks (default: 100)')
@click.option('--timeout', type=int, default=60, help='Timeout in minutes (default: 60)')
@click.option('--task-timeout', type=int, default=300, help='Individual task timeout in seconds (default: 300)')
@click.option('--max-retries', type=int, default=3, help='Maximum retries per task (default: 3)')
@click.option('--parallel', is_flag=True, help='Enable parallel execution')
@click.option('--monitor', is_flag=True, help='Enable monitoring')
@click.option('--output', '-o', 'output_formats', multiple=True, 
              type=click.Choice(['json', 'sqlite', 'csv', 'html']),
              help='Output formats (default: json)')
@click.option('--output-dir', type=click.Path(), default='./reports', 
              help='Output directory (default: ./reports)')
@click.option('--name', help='Benchmark name')
@click.option('--description', help='Benchmark description')
@click.option('--real-metrics', is_flag=True, help='Use real metrics collection (default: False)')
@click.pass_context
def run(ctx, objective, strategy, mode, max_agents, max_tasks, timeout, task_timeout, 
        max_retries, parallel, monitor, output_formats, output_dir, name, description, real_metrics):
    """Run a swarm benchmark with the specified objective.
    
    OBJECTIVE: The goal or task for the swarm to accomplish
    
    Examples:
      swarm-benchmark run "Build a REST API" --strategy development
      swarm-benchmark run "Research cloud architecture" --strategy research --mode distributed
      swarm-benchmark run "Analyze data trends" --strategy analysis --parallel
      swarm-benchmark run "Optimize performance" --mode distributed --monitor
    """
    # Create benchmark configuration
    config = BenchmarkConfig(
        name=name or f"benchmark-{strategy}-{mode}",
        description=description or f"Benchmark: {objective}",
        strategy=getattr(StrategyType, strategy.upper()),
        mode=getattr(CoordinationMode, mode.upper()),
        max_agents=max_agents,
        max_tasks=max_tasks,
        timeout=timeout * 60,  # Convert to seconds
        task_timeout=task_timeout,
        max_retries=max_retries,
        parallel=parallel,
        monitoring=monitor,
        output_formats=list(output_formats) if output_formats else ['json'],
        output_directory=output_dir,
        verbose=ctx.obj.get('verbose', False)
    )
    
    if ctx.obj.get('verbose'):
        click.echo(f"Running benchmark: {config.name}")
        click.echo(f"Objective: {objective}")
        click.echo(f"Strategy: {strategy}")
        click.echo(f"Mode: {mode}")
        click.echo(f"Real metrics: {'Enabled' if real_metrics else 'Disabled'}")
    
    # Run the benchmark
    try:
        result = asyncio.run(_run_benchmark(objective, config, real_metrics))
        
        if result:
            click.echo(f"✅ Benchmark completed successfully!")
            click.echo(f"📊 Results saved to: {output_dir}")
            if ctx.obj.get('verbose'):
                click.echo(f"📋 Summary: {result.get('summary', 'N/A')}")
                
            # Display metrics if available
            if 'metrics' in result and real_metrics:
                click.echo("\n📈 Performance Metrics:")
                metrics = result['metrics']
                click.echo(f"  • Wall clock time: {metrics.get('wall_clock_time', 0):.2f}s")
                click.echo(f"  • Tasks per second: {metrics.get('tasks_per_second', 0):.2f}")
                click.echo(f"  • Success rate: {metrics.get('success_rate', 0):.1%}")
                click.echo(f"  • Peak memory: {metrics.get('peak_memory_mb', 0):.1f} MB")
                click.echo(f"  • Average CPU: {metrics.get('average_cpu_percent', 0):.1f}%")
                click.echo(f"  • Total output: {metrics.get('total_output_lines', 0)} lines")
        else:
            click.echo("❌ Benchmark failed!")
            return 1
            
    except Exception as e:
        click.echo(f"❌ Error running benchmark: {e}")
        return 1
    
    return 0


@cli.command()
@click.option('--format', 'output_format', 
              type=click.Choice(['json', 'table', 'csv']),
              default='table',
              help='Output format (default: table)')
@click.option('--filter-strategy', help='Filter by strategy')
@click.option('--filter-mode', help='Filter by coordination mode')
@click.option('--limit', type=int, default=10, help='Limit number of results (default: 10)')
@click.pass_context
def list(ctx, output_format, filter_strategy, filter_mode, limit):
    """List recent benchmark runs."""
    try:
        benchmarks = _get_recent_benchmarks(filter_strategy, filter_mode, limit)
        
        if output_format == 'table':
            _display_benchmarks_table(benchmarks)
        elif output_format == 'json':
            click.echo(json.dumps(benchmarks, indent=2))
        elif output_format == 'csv':
            _display_benchmarks_csv(benchmarks)
            
    except Exception as e:
        click.echo(f"❌ Error listing benchmarks: {e}")
        return 1
    
    return 0


@cli.command()
@click.argument('benchmark_id')
@click.option('--format', 'output_format',
              type=click.Choice(['json', 'summary', 'detailed']),
              default='summary',
              help='Output format (default: summary)')
@click.pass_context
def show(ctx, benchmark_id, output_format):
    """Show details for a specific benchmark run."""
    try:
        benchmark = _get_benchmark_details(benchmark_id)
        
        if not benchmark:
            click.echo(f"❌ Benchmark {benchmark_id} not found")
            return 1
        
        if output_format == 'json':
            click.echo(json.dumps(benchmark, indent=2))
        elif output_format == 'summary':
            _display_benchmark_summary(benchmark)
        elif output_format == 'detailed':
            _display_benchmark_detailed(benchmark)
            
    except Exception as e:
        click.echo(f"❌ Error showing benchmark: {e}")
        return 1
    
    return 0


@cli.command()
@click.option('--all', is_flag=True, help='Delete all benchmark results')
@click.option('--older-than', type=int, help='Delete results older than N days')
@click.option('--strategy', help='Delete results for specific strategy')
@click.confirmation_option(prompt='Are you sure you want to delete benchmark results?')
@click.pass_context
def clean(ctx, all, older_than, strategy):
    """Clean up benchmark results."""
    try:
        deleted_count = _clean_benchmarks(all, older_than, strategy)
        click.echo(f"✅ Deleted {deleted_count} benchmark results")
        
    except Exception as e:
        click.echo(f"❌ Error cleaning benchmarks: {e}")
        return 1
    
    return 0


@cli.command()
@click.option('--port', type=int, default=8080, help='Server port (default: 8080)')
@click.option('--host', default='localhost', help='Server host (default: localhost)')
@click.pass_context
def serve(ctx, port, host):
    """Start the benchmark web interface."""
    try:
        click.echo(f"🚀 Starting benchmark server at http://{host}:{port}")
        click.echo("Press Ctrl+C to stop")
        
        # TODO: Implement web interface
        click.echo("⚠️  Web interface not yet implemented")
        
    except KeyboardInterrupt:
        click.echo("\n👋 Server stopped")
    except Exception as e:
        click.echo(f"❌ Error starting server: {e}")
        return 1
    
    return 0


@cli.group()
@click.pass_context
def real(ctx):
    """Real claude-flow command execution and benchmarking."""
    pass


@real.command('swarm')
@click.argument('objective')
@click.option('--strategy', 
              type=click.Choice(['auto', 'research', 'development', 'analysis', 'testing', 'optimization', 'maintenance']),
              default='auto',
              help='Execution strategy (default: auto)')
@click.option('--mode',
              type=click.Choice(['centralized', 'distributed', 'hierarchical', 'mesh', 'hybrid']),
              default='centralized', 
              help='Coordination mode (default: centralized)')
@click.option('--sparc-mode',
              help='Specific SPARC mode to test (e.g., coder, architect, reviewer)')
@click.option('--all-modes', is_flag=True, help='Test all SPARC modes and swarm strategies')
@click.option('--max-agents', type=int, default=5, help='Maximum agents (default: 5)')
@click.option('--timeout', type=int, default=60, help='Timeout in minutes (default: 60)')
@click.option('--task-timeout', type=int, default=300, help='Individual task timeout in seconds (default: 300)')
@click.option('--parallel', is_flag=True, help='Enable parallel execution')
@click.option('--monitor', is_flag=True, help='Enable monitoring')
@click.option('--output', '-o', 'output_formats', multiple=True, 
              type=click.Choice(['json', 'sqlite']),
              help='Output formats (default: json)')
@click.option('--output-dir', type=click.Path(), default='./reports', 
              help='Output directory (default: ./reports)')
@click.option('--name', help='Benchmark name')
@click.option('--description', help='Benchmark description')
@click.pass_context
def swarm(ctx, objective, strategy, mode, sparc_mode, all_modes, max_agents, timeout, 
         task_timeout, parallel, monitor, output_formats, output_dir, name, description):
    """Run real claude-flow swarm benchmarks with actual command execution.
    
    OBJECTIVE: The goal or task for claude-flow to accomplish
    
    Examples:
      swarm-benchmark real swarm "Build a REST API" --strategy development
      swarm-benchmark real swarm "Create a parser" --sparc-mode coder
      swarm-benchmark real swarm "Analyze code" --all-modes --parallel
      swarm-benchmark real swarm "Optimize performance" --mode distributed --monitor
    """
    # Create benchmark configuration
    config = BenchmarkConfig(
        name=name or f"real-benchmark-{strategy}-{mode}",
        description=description or f"Real Benchmark: {objective}",
        strategy=getattr(StrategyType, strategy.upper()),
        mode=getattr(CoordinationMode, mode.upper()),
        max_agents=max_agents,
        timeout=timeout * 60,  # Convert to seconds
        task_timeout=task_timeout,
        parallel=parallel,
        monitoring=monitor,
        output_formats=list(output_formats) if output_formats else ['json'],
        output_directory=output_dir,
        verbose=ctx.obj.get('verbose', False)
    )
    
    if ctx.obj.get('verbose'):
        click.echo(f"Running real benchmark: {config.name}")
        click.echo(f"Objective: {objective}")
        click.echo(f"Strategy: {strategy}")
        click.echo(f"Mode: {mode}")
        if sparc_mode:
            click.echo(f"SPARC Mode: {sparc_mode}")
        if all_modes:
            click.echo("Testing all modes: Yes")
    
    # Run the real benchmark
    try:
        result = asyncio.run(_run_real_benchmark(objective, config, sparc_mode, all_modes))
        
        if result:
            click.echo(f"✅ Real benchmark completed successfully!")
            click.echo(f"📊 Results saved to: {output_dir}")
            if ctx.obj.get('verbose'):
                click.echo(f"📋 Summary: {result.get('summary', 'N/A')}")
        else:
            click.echo("❌ Real benchmark failed!")
            return 1
            
    except Exception as e:
        click.echo(f"❌ Error running real benchmark: {e}")
        if ctx.obj.get('verbose'):
            import traceback
            click.echo(traceback.format_exc())
        return 1
    
    return 0


@real.command('hive-mind')
@click.argument('task')
@click.option('--queen-type', 
              type=click.Choice(['strategic', 'tactical', 'adaptive']),
              default='strategic',
              help='Queen coordinator type (default: strategic)')
@click.option('--max-workers', type=int, default=8, help='Maximum worker agents (default: 8)')
@click.option('--consensus', 
              type=click.Choice(['majority', 'weighted', 'byzantine']),
              default='majority',
              help='Consensus algorithm (default: majority)')
@click.option('--timeout', type=int, default=60, help='Timeout in minutes (default: 60)')
@click.option('--monitor', is_flag=True, help='Enable monitoring')
@click.option('--output-dir', type=click.Path(), default='./reports', 
              help='Output directory (default: ./reports)')
@click.pass_context
def hive_mind(ctx, task, queen_type, max_workers, consensus, timeout, monitor, output_dir):
    """Run real claude-flow hive-mind benchmarks.
    
    TASK: The task for the hive-mind to accomplish
    
    Examples:
      swarm-benchmark real hive-mind "Design architecture" --max-workers 8
      swarm-benchmark real hive-mind "Solve problem" --queen-type adaptive
      swarm-benchmark real hive-mind "Build system" --consensus byzantine
    """
    if ctx.obj.get('verbose'):
        click.echo(f"Running real hive-mind benchmark")
        click.echo(f"Task: {task}")
        click.echo(f"Queen Type: {queen_type}")
        click.echo(f"Max Workers: {max_workers}")
        click.echo(f"Consensus: {consensus}")
    
    # Execute real hive-mind command
    try:
        from ..core.claude_flow_real_executor import RealClaudeFlowExecutor, HiveMindCommand
        executor = RealClaudeFlowExecutor()
        
        # Create hive-mind configuration
        config = HiveMindCommand(
            task=task,
            action="spawn",
            spawn_count=max_workers,
            coordination_mode=consensus
        )
        
        # Add additional flags if needed
        if monitor:
            config.additional_flags.append("--monitor")
        
        result = executor.execute_hive_mind(config)
        
        if result.success:
            click.echo(f"✅ Hive-mind benchmark completed!")
            click.echo(f"📊 Results saved to: {output_dir}")
            if ctx.obj.get('verbose'):
                click.echo(f"Execution time: {result.duration:.2f}s")
                click.echo(f"Workers spawned: {result.agents_spawned}")
        else:
            error_msg = ""
            if result.errors:
                error_msg = "; ".join(result.errors)
            elif result.exit_code == -9:
                error_msg = f"Command timed out or was killed (exit code: {result.exit_code})"
            elif result.exit_code != 0:
                error_msg = f"Command failed with exit code: {result.exit_code}"
            else:
                error_msg = "Unknown error"
            click.echo(f"❌ Hive-mind benchmark failed: {error_msg}")
            if ctx.obj.get('verbose') and result.stderr_lines:
                click.echo(f"Stderr: {' '.join(result.stderr_lines[:5])}")
            return 1
            
    except Exception as e:
        click.echo(f"❌ Error running hive-mind: {e}")
        return 1
    
    return 0


@real.command('sparc')
@click.argument('mode', type=click.Choice(['coder', 'architect', 'tdd', 'reviewer', 'tester', 
                                          'optimizer', 'documenter', 'debugger']))
@click.argument('task')
@click.option('--namespace', help='Memory namespace')
@click.option('--timeout', type=int, default=60, help='Timeout in minutes (default: 60)')
@click.option('--non-interactive', is_flag=True, default=True, help='Non-interactive mode (default: True)')
@click.option('--output-dir', type=click.Path(), default='./reports', 
              help='Output directory (default: ./reports)')
@click.pass_context
def sparc(ctx, mode, task, namespace, timeout, non_interactive, output_dir):
    """Run real claude-flow SPARC mode benchmarks.
    
    MODE: The SPARC mode to use (coder, architect, tdd, etc.)
    TASK: The task to accomplish
    
    Examples:
      swarm-benchmark real sparc coder "Implement authentication"
      swarm-benchmark real sparc architect "Design microservices"
      swarm-benchmark real sparc tdd "Create test suite"
      swarm-benchmark real sparc reviewer "Review codebase"
    """
    if ctx.obj.get('verbose'):
        click.echo(f"Running real SPARC benchmark")
        click.echo(f"Mode: {mode}")
        click.echo(f"Task: {task}")
        if namespace:
            click.echo(f"Namespace: {namespace}")
    
    # Execute real SPARC command
    try:
        from ..core.claude_flow_real_executor import RealClaudeFlowExecutor, SparcCommand
        executor = RealClaudeFlowExecutor()
        
        # Create SPARC configuration
        config = SparcCommand(
            mode=mode,
            task=task,
            memory_key=namespace
        )
        
        result = executor.execute_sparc(config)
        
        if result.success:
            click.echo(f"✅ SPARC {mode} benchmark completed!")
            click.echo(f"📊 Results saved to: {output_dir}")
            if ctx.obj.get('verbose'):
                click.echo(f"Execution time: {result.duration:.2f}s")
                if result.total_tokens:
                    click.echo(f"Tokens used: {result.total_tokens}")
        else:
            click.echo(f"❌ SPARC benchmark failed: {result.error}")
            return 1
            
    except Exception as e:
        click.echo(f"❌ Error running SPARC: {e}")
        return 1
    
    return 0


async def _run_benchmark(objective: str, config: BenchmarkConfig, use_real_metrics: bool = False) -> Optional[dict]:
    """Run a benchmark with the given objective and configuration."""
    # Choose engine based on metrics flag
    if use_real_metrics:
        engine = RealBenchmarkEngine(config)
    else:
        engine = BenchmarkEngine(config)
    
    try:
        result = await engine.run_benchmark(objective)
        return result
    except Exception as e:
        click.echo(f"Error in benchmark execution: {e}")
        return None


async def _run_real_benchmark(objective: str, config: BenchmarkConfig, 
                              sparc_mode: Optional[str] = None,
                              all_modes: bool = False) -> Optional[dict]:
    """Run a real benchmark with actual claude-flow execution."""
    engine = RealBenchmarkEngine(config)
    
    try:
        if all_modes:
            # Test all modes comprehensively
            result = await engine.benchmark_all_modes(objective)
        elif sparc_mode:
            # Test specific SPARC mode
            result = await engine._execute_sparc_mode(sparc_mode, objective)
            result = {"sparc_mode": sparc_mode, "result": result}
        else:
            # Standard benchmark run
            result = await engine.run_benchmark(objective)
        
        return result
    except Exception as e:
        click.echo(f"Error in real benchmark execution: {e}")
        return None
    finally:
        # Ensure cleanup
        engine.cleanup()


def _get_recent_benchmarks(filter_strategy=None, filter_mode=None, limit=10):
    """Get recent benchmark runs."""
    # TODO: Implement database query
    return []


def _get_benchmark_details(benchmark_id: str):
    """Get details for a specific benchmark."""
    # TODO: Implement database query
    return None


def _clean_benchmarks(all_results=False, older_than=None, strategy=None):
    """Clean up benchmark results."""
    # TODO: Implement cleanup logic
    return 0


def _display_benchmarks_table(benchmarks):
    """Display benchmarks in table format."""
    if not benchmarks:
        click.echo("No benchmarks found.")
        return
    
    # TODO: Implement table display
    click.echo("Benchmark results (table format not yet implemented)")


def _display_benchmarks_csv(benchmarks):
    """Display benchmarks in CSV format."""
    # TODO: Implement CSV display
    click.echo("CSV output not yet implemented")


def _display_benchmark_summary(benchmark):
    """Display benchmark summary."""
    # TODO: Implement summary display
    click.echo("Summary display not yet implemented")


def _display_benchmark_detailed(benchmark):
    """Display detailed benchmark information."""
    # TODO: Implement detailed display
    click.echo("Detailed display not yet implemented")


def main():
    """Main entry point."""
    return cli()