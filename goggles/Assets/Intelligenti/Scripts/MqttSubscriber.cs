using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace Intelligenti
{
    public sealed class MqttSubscriber : MonoBehaviour
    {
        public event Action<string, string> MessageReceived;
        public event Action<bool, string> ConnectionChanged;

        private readonly ConcurrentQueue<Action> mainThreadActions = new();
        private CancellationTokenSource cancellation;
        private TcpClient client;
        private IntelligentiConfig config;
        private int packetIdentifier = 1;

        public void StartClient(IntelligentiConfig value)
        {
            config = value;
            cancellation?.Cancel();
            cancellation = new CancellationTokenSource();
            _ = RunReconnectLoop(cancellation.Token);
        }

        private void Update()
        {
            while (mainThreadActions.TryDequeue(out Action action))
                action();
        }

        private async Task RunReconnectLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await ConnectAndRead(token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception exception)
                {
                    EnqueueConnection(false, exception.Message);
                }

                try
                {
                    await Task.Delay(5000, token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task ConnectAndRead(CancellationToken token)
        {
            client?.Close();
            client = new TcpClient();
            await client.ConnectAsync(config.mqttHost, config.mqttPort);
            using NetworkStream stream = client.GetStream();

            await WritePacket(stream, BuildConnectPacket(), token);
            (byte type, byte[] body) = await ReadPacket(stream, token);
            if (type != 2 || body.Length < 2 || body[1] != 0)
                throw new IOException("MQTT CONNACK was rejected");

            await WritePacket(stream, BuildSubscribePacket(config.scanTopic), token);
            if (!string.IsNullOrWhiteSpace(config.targetTopic))
                await WritePacket(stream, BuildSubscribePacket(config.targetTopic), token);
            EnqueueConnection(true, "MQTT connected");

            while (!token.IsCancellationRequested && client.Connected)
            {
                (type, body) = await ReadPacket(stream, token);
                if (type == 3)
                    HandlePublish(body);
            }

            throw new IOException("MQTT disconnected");
        }

        private byte[] BuildConnectPacket()
        {
            using MemoryStream variable = new();
            WriteString(variable, "MQTT");
            variable.WriteByte(4);

            byte flags = 0x02;
            if (!string.IsNullOrEmpty(config.mqttUsername)) flags |= 0x80;
            if (!string.IsNullOrEmpty(config.mqttPassword)) flags |= 0x40;
            variable.WriteByte(flags);
            variable.WriteByte(0);
            variable.WriteByte(30);
            WriteString(variable, $"intelligenti-goggles-{Guid.NewGuid():N}"[..30]);
            if (!string.IsNullOrEmpty(config.mqttUsername))
                WriteString(variable, config.mqttUsername);
            if (!string.IsNullOrEmpty(config.mqttPassword))
                WriteString(variable, config.mqttPassword);

            return WrapPacket(0x10, variable.ToArray());
        }

        private byte[] BuildSubscribePacket(string topic)
        {
            using MemoryStream variable = new();
            int id = packetIdentifier++;
            variable.WriteByte((byte)(id >> 8));
            variable.WriteByte((byte)id);
            WriteString(variable, topic);
            variable.WriteByte(0);
            return WrapPacket(0x82, variable.ToArray());
        }

        private void HandlePublish(byte[] body)
        {
            if (body.Length < 2) return;
            int topicLength = body[0] << 8 | body[1];
            if (body.Length < 2 + topicLength) return;
            string topic = Encoding.UTF8.GetString(body, 2, topicLength);
            string payload = Encoding.UTF8.GetString(
                body, 2 + topicLength, body.Length - 2 - topicLength);
            mainThreadActions.Enqueue(() => MessageReceived?.Invoke(topic, payload));
        }

        private static async Task WritePacket(NetworkStream stream, byte[] packet,
            CancellationToken token)
        {
            await stream.WriteAsync(packet, 0, packet.Length, token);
            await stream.FlushAsync(token);
        }

        private static async Task<(byte type, byte[] body)> ReadPacket(
            NetworkStream stream, CancellationToken token)
        {
            int header = await ReadByte(stream, token);
            int multiplier = 1;
            int remainingLength = 0;
            int encoded;
            do
            {
                encoded = await ReadByte(stream, token);
                remainingLength += (encoded & 127) * multiplier;
                multiplier *= 128;
                if (multiplier > 128 * 128 * 128)
                    throw new IOException("Invalid MQTT remaining length");
            } while ((encoded & 128) != 0);

            byte[] body = new byte[remainingLength];
            int offset = 0;
            while (offset < body.Length)
            {
                int read = await stream.ReadAsync(body, offset, body.Length - offset, token);
                if (read == 0) throw new EndOfStreamException();
                offset += read;
            }
            return ((byte)(header >> 4), body);
        }

        private static async Task<int> ReadByte(NetworkStream stream,
            CancellationToken token)
        {
            byte[] one = new byte[1];
            int read = await stream.ReadAsync(one, 0, 1, token);
            if (read == 0) throw new EndOfStreamException();
            return one[0];
        }

        private static byte[] WrapPacket(byte header, byte[] body)
        {
            using MemoryStream packet = new();
            packet.WriteByte(header);
            int length = body.Length;
            do
            {
                int encoded = length % 128;
                length /= 128;
                if (length > 0) encoded |= 128;
                packet.WriteByte((byte)encoded);
            } while (length > 0);
            packet.Write(body, 0, body.Length);
            return packet.ToArray();
        }

        private static void WriteString(Stream stream, string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
            stream.WriteByte((byte)(bytes.Length >> 8));
            stream.WriteByte((byte)bytes.Length);
            stream.Write(bytes, 0, bytes.Length);
        }

        private void EnqueueConnection(bool connected, string message)
        {
            mainThreadActions.Enqueue(() => ConnectionChanged?.Invoke(connected, message));
        }

        private void OnDestroy()
        {
            cancellation?.Cancel();
            client?.Close();
        }
    }
}
