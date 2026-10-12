# Spike B: does the Patchwork site boot and sync in all three browsers inside a
# VM, and does a capture on the client show every egress attempt with its
# payload? Subduction runs natively on the host; the client reaches it through
# a single QEMU guest forward and nothing else.
# `dist` is the built site (src/harness/site/dist), passed in impurely;
# `subduction` is subduction_cli for the host platform.
{
  pkgs,
  dist,
  subduction,
}:
let
  # The client's only way out of its user-mode NIC.
  forward = {
    address = "10.0.2.100";
    port = 7000;
  };
  sync = "${forward.address}:${toString forward.port}";
  site = pkgs.runCommand "site-dist-vm" { } ''
    cp -r ${dist} $out
    chmod -R u+w $out
    find $out -type f \( -name '*.js' -o -name '*.html' \) \
      -exec sed -i 's/subduction\.harness\.invalid/${sync}/g' {} +
  '';
in
pkgs.testers.runNixOSTest {
  name = "harness-vm-spike-browsers";

  # Answers every DNS name with its own address and accepts every TCP port,
  # so that exfiltration attempts actually send their payload.
  nodes.attacker =
    {
      lib,
      pkgs,
      nodes,
      ...
    }:
    {
      # No QEMU user-mode NIC: unrestricted, it is a NAT to the internet.
      virtualisation.qemu.networkingOptions = lib.mkForce [ ];
      networking.firewall.enable = false;
      services.dnsmasq = {
        enable = true;
        resolveLocalQueries = false;
        settings = {
          address = "/#/${nodes.attacker.networking.primaryIPAddress}";
          no-resolv = true;
        };
      };
      # Stands in for the internet: the client's default gateway, so packets to
      # any address arrive here, and every TCP connection reaches the catch-all.
      networking.nftables = {
        enable = true;
        tables.catchall = {
          family = "inet";
          content = ''
            chain prerouting {
              type nat hook prerouting priority dstnat;
              iifname "eth1" tcp dport != 53 redirect to :9999
            }
          '';
        };
      };
      systemd.services.catchall = {
        wantedBy = [ "multi-user.target" ];
        script = "exec ${pkgs.python3}/bin/python3 ${./catchall.py} 9999 /tmp/catchall.log";
      };
    };

  nodes.client =
    { pkgs, nodes, ... }:
    {
      virtualisation.memorySize = 4096;
      virtualisation.cores = 4;
      # Reading the browsers from the host's store over 9p is very slow on macOS.
      virtualisation.useNixStoreImage = true;
      # QEMU's user-mode NIC reaches only the guest forward to the host's
      # Subduction, added at runtime through QEMU_NET_OPTS (see testScript).
      virtualisation.restrictNetwork = true;
      networking.useDHCP = false;
      networking.interfaces.eth0.ipv4.addresses = [
        {
          address = "10.0.2.15";
          prefixLength = 24;
        }
      ];
      networking.nameservers = [ nodes.attacker.networking.primaryIPAddress ];
      networking.defaultGateway = {
        address = nodes.attacker.networking.primaryIPAddress;
        interface = "eth1";
      };
      networking.defaultGateway6 = {
        address = nodes.attacker.networking.primaryIPv6Address;
        interface = "eth1";
      };
      environment.systemPackages = [
        pkgs.tcpdump
        pkgs.curl
        pkgs.netcat
        pkgs.nodejs_24
      ];
      fonts.enableDefaultPackages = true;
      # Mesa (llvmpipe) for WPE WebKit's EGL; Chromium and Firefox bring their own.
      hardware.graphics.enable = true;
      users.users.tester.isNormalUser = true;
      systemd.services.site = {
        wantedBy = [ "multi-user.target" ];
        script = "exec ${pkgs.python3}/bin/python3 -m http.server --bind 127.0.0.1 -d ${site} 8080";
      };
    };

  testScript = ''
    import os, socket, subprocess, tempfile, time

    # Subduction on the host, on a free port, with fresh storage. Its service
    # name is the address the clients dial.
    with socket.socket() as s:
      s.bind(("127.0.0.1", 0))
      port = s.getsockname()[1]
    data = tempfile.mkdtemp()
    host_subduction = subprocess.Popen(
      ["${subduction}/bin/subduction_cli", "server", "--socket", f"127.0.0.1:{port}",
       "--data-dir", data, "--ephemeral-key", "--service-name", "${sync}"],
      stdout=open(os.path.join(data, "log"), "w"), stderr=subprocess.STDOUT,
    )
    os.environ["QEMU_NET_OPTS"] = f"guestfwd=tcp:${sync}-cmd:${pkgs.netcat}/bin/nc 127.0.0.1 {port}"

    try:
      start_all()
      attacker.wait_for_unit("catchall.service")
      client.wait_for_open_port(8080)

      with subtest("the user-mode NIC reaches only the guest forward"):
        client.succeed("nc -z -w 5 ${forward.address} ${toString forward.port}")
        client.fail("curl -sf --max-time 5 --interface eth0 http://1.1.1.1/")
        client.fail(f"nc -z -w 5 10.0.2.2 {port}")  # the host directly, not through the forward
        client.fail("nc -z -w 5 10.0.2.2 22")
        client.succeed("ip route get 1.1.1.1 | grep -q eth1")

      client.succeed("tcpdump -i any -s 0 -w /tmp/cap.pcap -U >/dev/null 2>&1 & sleep 2")
      for browser in ["chromium", "firefox", "webkit"]:
        client.succeed(
          "(timeout 240 runuser -u tester -- env PLAYWRIGHT_BROWSERS_PATH=${pkgs.pkgsLinux.playwright-driver.browsers} "
          f"node ${./spike-probe.ts} ${pkgs.pkgsLinux.playwright-driver} http://localhost:8080/ {browser} "
          f"> /tmp/probe-{browser}.log 2>&1; echo EXIT=$? >> /tmp/probe-{browser}.log) >/dev/null 2>&1 &"
        )
        for _ in range(20):
          time.sleep(15)
          if "EXIT=" in client.succeed(f"cat /tmp/probe-{browser}.log"):
            break
        print(client.succeed(f"cat /tmp/probe-{browser}.log"))
      client.succeed("sleep 2; pkill -INT tcpdump; sleep 2")
      client.copy_from_vm("/tmp/cap.pcap")
      attacker.copy_from_vm("/tmp/catchall.log")

      with subtest("each browser syncs through the host's Subduction"):
        for browser in ["chromium", "firefox", "webkit"]:
          client.succeed(f"grep -q '^SYNCED {browser}' /tmp/probe-{browser}.log")

      with subtest("on eth0, only the Subduction flow"):
        eth0 = client.succeed("tcpdump -nn -r /tmp/cap.pcap 2>/dev/null | grep ' eth0 ' || true").splitlines()
        # The probe's RTCPeerConnection makes Chromium announce random .local
        # names over mDNS (and join its group), on every interface.
        webrtc_mdns = ["224.0.0.251.5353:", "> 224.0.0.22: igmp"]
        other = [
          l for l in eth0
          if "${forward.address}." not in l and " ARP" not in l and not any(m in l for m in webrtc_mdns)
        ]
        print(f"{len(eth0)} packets on eth0, {len(other)} neither the forward nor the probe's WebRTC mDNS")
        assert not other, "unexpected traffic on eth0:\n" + "\n".join(other[:20])

      with subtest("every canary is in the capture"):
        # Exact byte search: regex extraction from `strings` picks up adjacent
        # printable bytes of the pcap framing.
        missing = []
        for browser in ["chromium", "firefox", "webkit"]:
          for kind in ["fetch-host", "fetch-query", "image", "beacon-body", "websocket", "webrtc-stun", "ip-literal"]:
            c = f"canary-{browser}-{kind}"
            capture = client.execute(f"grep -aqF {c} /tmp/cap.pcap")[0] == 0
            caught = attacker.execute(f"grep -aqF {c} /tmp/catchall.log")[0] == 0
            print(f"{c:40} capture={'yes' if capture else 'NO '} attacker={'yes' if caught else 'no'}")
            if not capture:
              missing.append(c)
        assert not missing, f"canaries missing from the capture: {missing}"
    finally:
      host_subduction.terminate()
      host_subduction.wait()
      print(open(os.path.join(data, "log")).read()[-3000:])
  '';
}
