# Boat

T3 Code can run threads on [Boat](https://boat.dev) VMs instead of your machine. Each VM runs its
own T3 Code server, so a cloud thread works like any other thread: it streams, keeps its history,
and you can follow it from any client.

## Set it up

1. Create a Boat API key with these scopes: `sandbox.create`, `sandbox.read`, `sandbox.update`,
   `sandbox.stop`, `sandbox.resume`, `sandbox.delete`, `exec`, `file.read`, `file.write`, `host`,
   `ssh`, `snapshot.read`, `snapshot.write`, `account.read`, `account.admin`, `environment.read`,
   `environment.write`. `account.admin` lets T3 Code see which agent sign-ins you added, never
   their values.
2. Open **Settings → Environments**, paste the key in the **Boat** section, and choose
   **Connect**. The key is saved on every connected machine.
3. Setup starts on its own: T3 Code creates a VM, installs the T3 Code server so it starts on
   boot, clones your most worked repositories, copies your machine's skills, and saves a Boat
   snapshot named `t3-code`. Every cloud VM starts from it. Choose **Rebuild snapshot** after you
   change your skills or update T3 Code.
4. Under **Boat environment**, choose the Boat environment new VMs start on. It starts on Boat's
   default, and the row says whether threads can start on it. Below it:
   - **Agents** shows which providers the environment's sign-ins cover. A thread cannot start
     without at least one: choose **Add sign-in** to add a Claude or ChatGPT sign-in on Boat's
     [Agents & Proxying](https://boat.dev/dashboard?tab=agents) page.
   - **GitHub** shows whether Boat's GitHub app is connected. Private repositories and pushes need
     it. If you signed in to Boat with Google or email, choose **Connect** to open Boat's
     [Environment](https://boat.dev/dashboard?tab=environment) page.
   - **Secrets** gives VMs the environment's variables and secret files.
   - **Boat key on VMs** puts a Boat key for your account on each VM, so agents there can start,
     stop and delete VMs billed to you. T3 Code does not need it; leave it off unless an agent must
     manage VMs itself.

   A VM keeps the environment it started on, even after it stops, so a change only applies to new
   VMs.

## Start a cloud thread

In a new thread, open the machine picker and choose **Boat**, or use **New Boat thread**
in the command palette. If Boat cannot start a thread yet, for example because its environment has
no agent sign-in, the composer says so with a link to the setting to fix. A VM starts getting ready
as soon as you pick Boat. When you send the
first message, it shows in the thread right away, and the app lists each step as it runs: finding a
VM, starting T3 Code, cloning or updating the repository, connecting, opening the project, and
starting the thread, which lives on the VM from then on. T3 Code reuses a running VM that is under
half its CPU and memory, preferring one that already has the repository, or starts a new VM from the
snapshot. A VM from the snapshot is usually ready in under 10 seconds.

Next to the machine picker, choose the VM size: Small, Medium, Large or Extra large. Each size lists its vCPUs, memory and hourly price;
a size your Boat plan cannot start is shown with the reason. New threads use the **Default size**
from the Boat section unless you pick another. With **Share machines** off, each cloud thread
gets a VM of its own; turn it on to let threads join a running VM that has room. **Keep a ready
machine** keeps an idle VM at the default size running while you use T3 Code, so a start skips the
boot. That VM is billed at its hourly price; it is off by default, and turning it off deletes the
idle VM. The thread's details panel shows its VM's size, state, CPU, memory, disk and cost.

A cloud thread always works in a new worktree, so several threads can share a VM. You choose only
the base branch. The thread keeps your model and access settings, and its attachments go with it.

The project needs a pushed Git remote: the VM clones it, so local-only branches and commits are not
there. When an agent finishes, it commits and pushes its branch. It opens a pull request only when
you ask. Providers on a VM use the agent sign-ins from its Boat environment, so a cloud thread only
offers the providers those sign-ins cover.

## When VMs stop

A VM turns off once none of its threads has run a turn for 10 minutes. A connected machine holding
the key stops it a minute early and first saves a copy of the VM's threads, provider sessions, and
checkouts. A thread on a stopped VM shows it as sleeping. Your next message turns the same VM back
on and the thread continues. If Boat deleted the VM, a new one starts from the saved copy.
**Machines**, under the **Boat** section of **Settings → Environments**, lists each VM by its
threads, with its size and cost, and lets you stop, wake or delete it. VMs are not listed with your
other environments.

An agent can also start a thread on Boat for you. Its VM's threads show in your thread list once
this client connects to the VM, which it does on its own while the VM runs, or when you open a link
to one of its threads.
