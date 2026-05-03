"""Parse a tab-separated server log and summarize errors by endpoint.

This file is here for the code-editing demo. It works, but it's
written verbosely on purpose so you have something to refactor.
"""

import sys


def parse_logs(path):
    file = open(path)
    lines = file.readlines()
    file.close()

    results = {}
    for line in lines:
        parts = line.strip().split("\t")
        if len(parts) < 4:
            continue
        timestamp = parts[0]
        method = parts[1]
        endpoint = parts[2]
        status = parts[3]

        status_int = int(status)
        if status_int >= 500:
            if endpoint in results:
                results[endpoint] = results[endpoint] + 1
            else:
                results[endpoint] = 1

    sorted_results = []
    for endpoint in results:
        sorted_results.append((endpoint, results[endpoint]))

    sorted_results.sort(key=lambda x: x[1], reverse=True)
    return sorted_results


def print_report(results):
    print("Errors by endpoint:")
    print("-" * 40)
    for endpoint, count in results:
        print(endpoint + ": " + str(count))


if __name__ == "__main__":
    path = sys.argv[1]
    results = parse_logs(path)
    print_report(results)
